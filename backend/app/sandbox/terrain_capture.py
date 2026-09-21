"""
DamSafe Twin Sandbox — on-demand standalone 3D terrain capture.

The God's Eye globe is only a *viewer* (Cesium streaming tiles); what makes a
dam sandboxable is a standalone terrain GLB in frontend/public/terrain/ (real
DEM mesh + satellite texture + local-frame transform). This module builds that
asset for ANY dam in the registry, on demand:

    provider-chain DEM (same chain the sandbox simulates on)
      -> process + nodata fill
      -> Esri World Imagery texture warped to the DEM grid
      -> 129x129 Y-up GLB mesh (identical conventions to the curated
         terrain-pipeline: x=east, y=up, z=south, row0=north)
      -> publish <dam_id>.{glb,metadata.json,transform.json} into the
         frontend terrain tree + merge into manifest.json

Conventions (rows/UV/frames) are ported 1:1 from
3d-assets/terrain-pipeline/terrain_pipeline.py so the output is
indistinguishable from curated assets — same loaders, same sandbox
mapping, same camera framing. No synthetic DEMs: terrain failure raises
TerrainUnavailableError, exactly like the simulation path.
"""

from __future__ import annotations

import json
import math
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from app.sandbox.dam_registry import get_dam
from app.sandbox.terrain import _roots, terrain_dir
from app.sandbox.terrain_providers import TerrainUnavailableError, ensure_dem

ESRI_EXPORT_URL = (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
)

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_TERRAIN = BACKEND_DIR.parent / "frontend" / "public" / "terrain"
MANIFEST = FRONTEND_TERRAIN / "manifest.json"

MESH_SIZE = 129          # 129x129 ≈ the curated mesh grid (~90 m over ±5 km)
RADIUS_KM = 5.0          # ±5 km window, matching curated assets
EXAGGERATION = 1.0

_lock = threading.Lock()  # serialize captures (shared manifest write)


class CaptureError(RuntimeError):
    """Capture failed after real attempts (message is safe to expose)."""


# ── geo helpers (ported from terrain_pipeline.py) ───────────────────────────

def _lla_to_ecef(lat_deg: float, lon_deg: float, h: float) -> np.ndarray:
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    x = (n + h) * math.cos(lat) * math.cos(lon)
    y = (n + h) * math.cos(lat) * math.sin(lon)
    z = (n * (1 - WGS84_E2) + h) * math.sin(lat)
    return np.array([x, y, z], dtype=np.float64)


def _r_enu_to_ecef(lat_deg: float, lon_deg: float) -> np.ndarray:
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
    return np.array([
        [-so, -sl * co, cl * co],
        [co, -sl * so, cl * so],
        [0.0, cl, sl],
    ], dtype=np.float64)


def _build_model_matrix(lat: float, lon: float, h_center: float) -> np.ndarray:
    """4x4 row-major: local glTF (E, U, -N) -> ECEF."""
    r_enu = _r_enu_to_ecef(lat, lon)
    m_gltf2enu = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64)
    r = r_enu @ m_gltf2enu
    t = _lla_to_ecef(lat, lon, h_center)
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = r
    m[:3, 3] = t
    return m


def _bbox_from_center(lat: float, lon: float, radius_km: float):
    dlat = radius_km / 110.54
    dlon = radius_km / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


# ── stages ──────────────────────────────────────────────────────────────────

def _acquire_dem(dam_id: str, lat: float, lon: float, out_dir: Path) -> tuple[Path, str]:
    """Real DEM via the backend's provider chain (no synthetic fallback)."""
    existing = next((r for r in _roots() if (r / dam_id / "dem_raw.tif").exists()
                     and (r / dam_id / "dem_raw.tif").stat().st_size > 10_000), None)
    if existing is not None:
        return existing / dam_id / "dem_raw.tif", "curated-DEM (existing)"
    dem_path, provenance = ensure_dem(dam_id, lat, lon, _roots(), out_dir)
    if not dem_path.exists():
        raise CaptureError(
            f"DEM acquisition failed for '{dam_id}': "
            + " | ".join(provenance.get("attempt_trail", [])[-3:])
        )
    src = provenance.get("source") or provenance.get("dataset") or "provider-chain DEM"
    return dem_path, f"{src} (provider chain)"


def _load_dem_grid(dem_path: Path) -> dict:
    """Full-res elevation grid + georeferencing (rasterio, nodata filled)."""
    import rasterio

    with rasterio.open(dem_path) as src:
        arr = src.read(1).astype(np.float64)
        bounds = src.bounds
        crs = str(src.crs)
        nodata = src.nodata
    mask = ~np.isfinite(arr)
    if nodata is not None:
        mask |= arr == nodata
    if mask.any():
        try:
            from scipy.ndimage import distance_transform_edt
            _, idx = distance_transform_edt(mask, return_indices=True)
            arr[mask] = arr[tuple(idx[:, mask])]
        except Exception:
            arr[mask] = np.nanmean(arr)
    return {
        "elevation": arr,  # row0 = north, col0 = west
        "rows": arr.shape[0],
        "cols": arr.shape[1],
        "min_m": float(arr.min()),
        "max_m": float(arr.max()),
        "mean_m": float(arr.mean()),
        "bbox": [bounds.left, bounds.bottom, bounds.right, bounds.top],
        "crs": crs,
        "nodata_filled": bool(mask.any()),
    }


def _fetch_texture_esri(bbox, rows: int, cols: int, out_path: Path) -> str:
    """Esri World Imagery for the exact bbox, resized to the DEM grid."""
    from PIL import Image

    west, south, east, north = bbox
    r = requests.get(ESRI_EXPORT_URL, params={
        "bbox": f"{west},{south},{east},{north}",
        "bboxSR": "4326", "imageSR": "4326",
        "size": f"{min(cols, 2048)},{min(rows, 2048)}",
        "format": "png32", "f": "image",
    }, timeout=120)
    r.raise_for_status()
    Image.open(__import__("io").BytesIO(r.content)).convert("RGB").resize(
        (cols, rows), Image.BILINEAR).save(out_path)
    return "Esri:World_Imagery"


def _downsample_grid(arr: np.ndarray, mesh_size: int) -> np.ndarray:
    h, w = arr.shape
    sy = max(1, math.ceil(h / mesh_size))
    sx = max(1, math.ceil(w / mesh_size))
    return arr[::sy, ::sx]


def _build_mesh_export_glb(elev: np.ndarray, bbox, center, texture_path: Path,
                           glb_path: Path, exaggeration: float = 1.0) -> dict:
    """Y-up GLB identical in convention to the curated pipeline output."""
    import trimesh
    from PIL import Image
    from trimesh.visual import TextureVisuals
    from trimesh.visual.material import PBRMaterial

    west, south, east, north = bbox
    clat, clon = center
    h, w = elev.shape
    m_per_deg_lat = 110540.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(clat))
    xs = (np.linspace(west, east, w) - clon) * m_per_deg_lon
    ys = (np.linspace(north, south, h) - clat) * m_per_deg_lat
    E, N = np.meshgrid(xs, ys)
    h_center = float(elev.mean())
    H = (elev - h_center) * exaggeration

    verts = np.column_stack([E.ravel(), H.ravel(), (-N).ravel()]).astype(np.float64)
    idx = np.arange(h * w, dtype=np.int64).reshape(h, w)
    q00, q01 = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel()
    q10, q11 = idx[1:, :-1].ravel(), idx[1:, 1:].ravel()
    faces = np.vstack([np.column_stack([q00, q10, q11]),
                       np.column_stack([q00, q11, q01])]).astype(np.int64)

    uu, vv = np.meshgrid(np.linspace(0, 1, w), np.linspace(1, 0, h))
    uv = np.column_stack([uu.ravel(), vv.ravel()]).astype(np.float64)

    image = Image.open(texture_path).convert("RGB")
    material = PBRMaterial(name="terrain", baseColorTexture=image,
                           metallicFactor=0.0, roughnessFactor=1.0)
    mesh = trimesh.Trimesh(vertices=verts, faces=faces,
                           visual=TextureVisuals(uv=uv, material=material, image=image),
                           process=False)
    try:
        mesh.fix_normals()
    except Exception:
        pass
    glb_bytes = mesh.export(file_type="glb")
    glb_path.write_bytes(glb_bytes if isinstance(glb_bytes, (bytes, bytearray)) else bytes(glb_bytes))
    return {
        "vertices": len(verts), "faces": len(faces),
        "center_elevation_m": h_center,
        "width_m": float(xs.max() - xs.min()),
        "height_m": float(ys.max() - ys.min()),
    }


# ── publish ─────────────────────────────────────────────────────────────────

def _read_manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def _publish(dam_id: str, name: str, files: dict[str, Path]) -> None:
    """Copy glb/metadata/transform into the frontend tree + update manifest."""
    FRONTEND_TERRAIN.mkdir(parents=True, exist_ok=True)
    for filename, src in files.items():
        (FRONTEND_TERRAIN / filename).write_bytes(src.read_bytes())

    manifest = _read_manifest()
    manifest[dam_id] = {"name": name, "file": dam_id}
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def capture_status(dam_id: str) -> dict:
    entry = _read_manifest().get(dam_id)
    glb = FRONTEND_TERRAIN / f"{dam_id}.glb"
    return {
        "dam_id": dam_id,
        "available": bool(entry) and glb.exists(),
        "entry": entry,
    }


def capture_terrain(dam_id: str, *, radius_km: float = RADIUS_KM,
                    mesh_size: int = MESH_SIZE) -> dict:
    """Build + publish the standalone 3D terrain for a dam. Thread-safe,
    idempotent (re-capture overwrites). Returns what was written."""
    with _lock:
        rec = get_dam(dam_id)
        if rec is None:
            raise FileNotFoundError(f"Unknown dam id '{dam_id}'.")
        lat, lon, name = float(rec["lat"]), float(rec["lon"]), rec["name"]

        work = terrain_dir() / dam_id
        work.mkdir(parents=True, exist_ok=True)

        # Stage 1: real DEM (provider chain; never synthetic)
        dem_path, dem_source = _acquire_dem(dam_id, lat, lon, work)
        dem = _load_dem_grid(dem_path)

        # Stage 3: satellite texture warped to the DEM grid
        tex_path = work / "texture.png"
        try:
            tex_source = _fetch_texture_esri(dem["bbox"], dem["rows"], dem["cols"], tex_path)
        except Exception as e:
            raise CaptureError(f"Imagery fetch failed for '{dam_id}': {e}") from e

        # Stage 4: mesh + GLB
        elev_small = _downsample_grid(dem["elevation"], mesh_size)
        glb_path = work / f"{dam_id}.glb"
        mesh_info = _build_mesh_export_glb(elev_small, dem["bbox"], (lat, lon),
                                           tex_path, glb_path, EXAGGERATION)

        model_matrix = _build_model_matrix(lat, lon, mesh_info["center_elevation_m"])
        ecef_center = _lla_to_ecef(lat, lon, mesh_info["center_elevation_m"])
        transform = {
            "dam": name, "lat": lat, "lon": lon,
            "center_elevation_m": mesh_info["center_elevation_m"],
            "vertical_exaggeration": EXAGGERATION,
            "local_frame": "Y-up: x=east(m), y=up-relative-to-center(m, exaggerated), z=south(m, i.e. -north)",
            "placement": "Cesium: Model.fromGltf({url, modelMatrix}) with modelMatrix below; "
                         "or entity position=center_ecef + orientation from matrix rotation.",
            "center_ecef_m": [float(v) for v in ecef_center],
            "modelMatrix_columnMajor": [float(v) for v in model_matrix.reshape(-1, order="F")],
            "modelMatrix_rowMajor": [float(v) for v in model_matrix.reshape(-1, order="C")],
            "mesh_extent_m": {"width_east_west": mesh_info["width_m"],
                              "height_north_south": mesh_info["height_m"]},
            "glb": f"{dam_id}.glb",
        }
        (work / "transform.json").write_text(json.dumps(transform, indent=2), encoding="utf-8")

        metadata = {
            "dam": name, "lat": lat, "lon": lon,
            "bbox_radius_km": radius_km,
            "bbox_wsen": dem["bbox"],
            "crs": dem["crs"],
            "elevation_min_m": dem["min_m"],
            "elevation_max_m": dem["max_m"],
            "elevation_mean_m": dem["mean_m"],
            "nodata_filled": dem["nodata_filled"],
            "dem_grid": {"rows": dem["rows"], "cols": dem["cols"]},
            "mesh_grid": {"rows": int(elev_small.shape[0]), "cols": int(elev_small.shape[1])},
            "vertical_exaggeration": EXAGGERATION,
            "sources": {"dem": dem_source, "texture": tex_source},
            "created_utc": datetime.now(timezone.utc).isoformat(),
        }
        (work / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        _publish(dam_id, name, {
            f"{dam_id}.glb": glb_path,
            f"{dam_id}.metadata.json": work / "metadata.json",
            f"{dam_id}.transform.json": work / "transform.json",
        })

        return {
            "dam_id": dam_id,
            "name": name,
            "mesh_grid": metadata["mesh_grid"],
            "elevation_min_m": metadata["elevation_min_m"],
            "elevation_max_m": metadata["elevation_max_m"],
            "bbox_wsen": metadata["bbox_wsen"],
            "sources": metadata["sources"],
            "vertices": mesh_info["vertices"],
            "faces": mesh_info["faces"],
            "published": [f"/terrain/{dam_id}.glb", f"/terrain/{dam_id}.metadata.json",
                          f"/terrain/{dam_id}.transform.json"],
        }


# Re-export so the router can return honest 503s with the provider trail.
__all__ = ["capture_terrain", "capture_status", "CaptureError",
           "TerrainUnavailableError"]
