"""
DamSafe Twin — Dam-site terrain-to-glTF pipeline.

Given a dam name (from dams.json) or lat/lon, produces a small georeferenced,
satellite-textured 3D terrain model ready for CesiumJS / GeoLibre:

    output/<dam_name>/dem_raw.tif
    output/<dam_name>/texture.png
    output/<dam_name>/<dam_name>.glb   (self-contained, texture embedded)
    output/<dam_name>/transform.json   (placement info for Cesium)
    output/<dam_name>/metadata.json    (bbox, elevations, CRS, sources)

Geo-anchoring decision (documented):
  LOCAL ENU MESH + transform.json (NOT baked ECEF, NOT CESIUM_RTC).
  - Mesh vertices are local meters in a Y-up frame:
        x = east offset from site center (m)
        y = (elevation - center_elevation) * exaggeration (m)
        z = -(north offset from site center) (m)   # so +z points south
  - transform.json carries lon/lat/center_elevation plus a 4x4
    modelMatrix (column-major, Cesium.Matrix4-compatible) that maps
    local mesh space -> ECEF:
        M = T(center_ecef) @ R_enu_to_ecef @ M_gltf2enu
    where M_gltf2enu maps (E, U, -N) -> (E, N, U).
  - Frontend placement: Cesium.Model.fromGltf({url, modelMatrix}) or an
    entity with `position` = center + `orientation` from the matrix.
  - Rationale: baked-ECEF vertices (~6e6 m) lose precision in float32
    glTF accessors (vertex jitter); CESIUM_RTC is legacy/deprecated with
    poor tooling. Local ENU keeps coordinates small and exact.

Mesh/export decision: `trimesh` builds the triangulated grid, assigns UVs,
embeds texture.png, and exports a single .glb. (pygltflib is NOT required
for the build; optionally handy for offline validation.)

Usage:
    python terrain_pipeline.py --dam "Tehri Dam"
    python terrain_pipeline.py --dam "Tehri Dam" --demo          # offline synthetic data
    python terrain_pipeline.py --lat 30.3783 --lon 78.4808 --name "Custom Dam"
    python terrain_pipeline.py --dam "Bhakra Dam" --radius-km 3 --mesh-size 192 --exaggeration 1.5

Env:
    OPENTOPOGRAPHY_API_KEY  (required for real DEM; --demo skips it)
    Multi-key rotation (optional, recommended for batch runs):
      OPENTOPOGRAPHY_API_KEY_1, OPENTOPOGRAPHY_API_KEY_2, ... and/or
      OPENTOPO_KEYS="keyA,keyB,..." (or OPENTOPOGRAPHY_API_KEYS).
    Keys are NEVER logged. Exhausted keys are skipped for the rest of the
    run; rate-limited keys cool down briefly before reuse.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / "dams.json"
OUTPUT_ROOT = HERE / "output"

OPENTOPO_URL = "https://portal.opentopography.org/API/globaldem"
ESRI_EXPORT_URL = (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
)

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


# --------------------------------------------------------------------------
# Stage 0: registry / site resolution
# --------------------------------------------------------------------------

def load_registry(path: Path = REGISTRY) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def resolve_site(dam: str | None, lat: float | None, lon: float | None,
                 radius_km: float | None, name: str | None) -> dict:
    reg = load_registry()
    default_radius = float(reg.get("defaults", {}).get("bbox_radius_km", 5.0))
    if dam:
        for entry in reg.get("dams", []):
            if entry["name"].lower() == dam.lower():
                return {
                    "name": entry["name"],
                    "lat": float(entry["lat"]),
                    "lon": float(entry["lon"]),
                    "radius_km": float(radius_km or entry.get("bbox_radius_km", default_radius)),
                }
        raise SystemExit(f'Dam "{dam}" not found in dams.json. Available: '
                         + ", ".join(e["name"] for e in reg.get("dams", [])))
    if lat is not None and lon is not None:
        return {
            "name": name or f"site_{lat:.4f}_{lon:.4f}",
            "lat": float(lat),
            "lon": float(lon),
            "radius_km": float(radius_km or default_radius),
        }
    raise SystemExit("Provide --dam NAME or both --lat and --lon.")


def bbox_from_center(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """(west, south, east, north) degrees approximating a square of given radius."""
    dlat = radius_km / 110.54
    dlon = radius_km / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def safe_dirname(name: str) -> str:
    keep = "".join(c if (c.isalnum() or c in ("-", "_", " ")) else "_" for c in name).strip()
    return keep.replace(" ", "_") or "site"


# --------------------------------------------------------------------------
# Geo math (WGS84 <-> ECEF, ENU frames)
# --------------------------------------------------------------------------

def lla_to_ecef(lat_deg: float, lon_deg: float, h: float) -> np.ndarray:
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    x = (n + h) * math.cos(lat) * math.cos(lon)
    y = (n + h) * math.cos(lat) * math.sin(lon)
    z = (n * (1 - WGS84_E2) + h) * math.sin(lat)
    return np.array([x, y, z], dtype=np.float64)


def r_enu_to_ecef(lat_deg: float, lon_deg: float) -> np.ndarray:
    """3x3 rotation taking ENU offsets -> ECEF offsets at given origin."""
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
    return np.array([
        [-so, -sl * co, cl * co],
        [co, -sl * so, cl * so],
        [0.0, cl, sl],
    ], dtype=np.float64)


def build_model_matrix(lat: float, lon: float, h_center: float) -> np.ndarray:
    """4x4 row-major: local glTF (E, U, -N) -> ECEF."""
    r_enu = r_enu_to_ecef(lat, lon)
    # gltf->ENU: (x=E, y=U, z=-N) => ENU = (x, -z, y)
    m_gltf2enu = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64)
    r = r_enu @ m_gltf2enu
    t = lla_to_ecef(lat, lon, h_center)
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = r
    m[:3, 3] = t
    return m


# --------------------------------------------------------------------------
# Stage 1: DEM acquisition (OpenTopography, with offline demo fallback)
# --------------------------------------------------------------------------

class OTError(RuntimeError):
    """Classified OpenTopography failure. `kind` drives retry/batch policy.

    Kinds: invalid_key | quota_exceeded | rate_limited | dataset_unavailable
           | network_error | unknown
    Policy: retry with backoff ONLY on network_error. Never retry quota/
    invalid-key failures endlessly — record and move on.
    """

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


# --------------------------------------------------------------------------
# Multi-key rotation (OpenTopography quota fallback)
# --------------------------------------------------------------------------
# Keys are collected from (highest priority first):
#   1. --opentopo-key "k1,k2,..." (comma/space separated, single key still ok)
#   2. OPENTOPOGRAPHY_API_KEY_1, _2, ... _N environment variables
#   3. OPENTOPO_KEYS / OPENTOPOGRAPHY_API_KEYS env (comma/space separated)
#   4. OPENTOPOGRAPHY_API_KEY env (legacy single key)
# Placeholders ("paste_your_key_here", "xxx", ...) and empties are ignored.
# Key VALUES are never printed or logged — only their 1-based index.

_PLACEHOLDER_KEYS = {"", "paste_your_key_here", "your_key_here", "changeme", "xxx"}

_RATE_LIMIT_COOLDOWN_S = 60.0


def _split_keys(blob: str | None) -> list[str]:
    if not blob:
        return []
    parts = [p.strip() for p in blob.replace(",", " ").split()]
    return [p for p in parts if p and p.lower() not in _PLACEHOLDER_KEYS]


def collect_opentopo_keys(explicit: str | None = None) -> list[str]:
    """Collect usable OpenTopography API keys without ever logging values."""
    keys: list[str] = []
    keys.extend(_split_keys(explicit))
    numbered: list[tuple[int, str]] = []
    for name, value in os.environ.items():
        m = name.upper().replace("-", "_")
        if m.startswith("OPENTOPOGRAPHY_API_KEY_") and m[len("OPENTOPOGRAPHY_API_KEY_"):].isdigit():
            idx = int(m[len("OPENTOPOGRAPHY_API_KEY_"):])
            for k in _split_keys(value):
                numbered.append((idx, k))
    for _, k in sorted(numbered):
        if k not in keys:
            keys.append(k)
    for env_name in ("OPENTOPO_KEYS", "OPENTOPOGRAPHY_API_KEYS"):
        for k in _split_keys(os.environ.get(env_name)):
            if k not in keys:
                keys.append(k)
    for k in _split_keys(os.environ.get("OPENTOPOGRAPHY_API_KEY")):
        if k not in keys:
            keys.append(k)
    return keys


class OpenTopoKeyPool:
    """Round-robin pool with per-key failure tracking.

    - invalid_key / quota_exceeded → key retired for the rest of the run.
    - rate_limited → key cools down for _RATE_LIMIT_COOLDOWN_S, then reusable.
    - network / dataset errors do NOT retire the key.
    """

    def __init__(self, keys: list[str]):
        import time as _time
        self._time = _time
        self._keys = list(keys)
        self._cursor = 0
        self._retired: set[int] = set()
        self._cooldown_until: dict[int, float] = {}

    def __len__(self) -> int:
        return len(self._keys)

    @property
    def retired_count(self) -> int:
        return len(self._retired)

    def _available(self, idx: int) -> bool:
        if idx in self._retired:
            return False
        until = self._cooldown_until.get(idx, 0.0)
        return self._time.time() >= until

    def has_usable_key(self) -> bool:
        return any(self._available(i) for i in range(len(self._keys)))

    def next_index(self) -> int | None:
        """Next usable key index (round-robin), or None if all retired/cooldown."""
        n = len(self._keys)
        for step in range(n):
            idx = (self._cursor + step) % n
            if self._available(idx):
                self._cursor = (idx + 1) % n
                return idx
        return None

    def report(self, idx: int, kind: str) -> None:
        if kind in ("invalid_key", "quota_exceeded"):
            self._retired.add(idx)
            print(f"[dem] key #{idx + 1} retired ({kind}); "
                  f"{len(self._keys) - len(self._retired)} key(s) left.",
                  file=sys.stderr)
        elif kind == "rate_limited":
            self._cooldown_until[idx] = self._time.time() + _RATE_LIMIT_COOLDOWN_S
            print(f"[dem] key #{idx + 1} rate-limited; cooling down "
                  f"{int(_RATE_LIMIT_COOLDOWN_S)}s.", file=sys.stderr)


def _cache_dir() -> Path:
    d = Path(os.environ.get("OPENTOPO_CACHE_DIR", str(HERE / "cache")))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(bbox, demtype: str) -> str:
    west, south, east, north = bbox
    return f"{demtype}_{west:.4f}_{south:.4f}_{east:.4f}_{north:.4f}.tif"


def _cached_dem_valid(path: Path) -> bool:
    """A cached DEM is valid if rasterio opens it with a sane grid."""
    try:
        import rasterio
        with rasterio.open(path) as src:
            return src.count >= 1 and src.width >= 16 and src.height >= 16
    except Exception:
        return False


def _classify_ot_response(status: int, text: str) -> str:
    t = (text or "").lower()
    if status == 401 or ("invalid" in t and "key" in t) or "unauthorized" in t:
        return "invalid_key"
    if status == 429 or "rate" in t and "limit" in t or "too many requests" in t:
        return "rate_limited"
    if "quota" in t or "exceed" in t or "usage limit" in t:
        return "quota_exceeded"
    if status == 404 or "demtype" in t or "no data" in t or "dataset" in t:
        return "dataset_unavailable"
    return "unknown"


def _ot_get(params: dict, timeout: int = 120, retries: int = 3) -> requests.Response:
    """GET with exponential backoff on TRANSIENT failures only.

    Retries: timeouts, connection errors, HTTP 5xx. Raises OTError
    immediately for auth/quota/rate-limit responses (no endless retry).
    """
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            r = requests.get(OPENTOPO_URL, params=params, timeout=timeout)
        except (requests.Timeout, requests.ConnectionError) as e:
            last_exc = e
            wait = 2 ** (attempt + 1)
            print(f"[dem] transient network error ({e.__class__.__name__}), "
                  f"retry {attempt + 1}/{retries} in {wait}s", file=sys.stderr)
            import time
            time.sleep(wait)
            continue
        if r.status_code >= 500:
            wait = 2 ** (attempt + 1)
            print(f"[dem] server error {r.status_code}, retry {attempt + 1}/{retries} in {wait}s",
                  file=sys.stderr)
            import time
            time.sleep(wait)
            continue
        return r
    raise OTError("network_error", f"OpenTopography unreachable after {retries} tries: {last_exc}")


def fetch_dem_opentopo(bbox, out_path: Path,
                       api_key: str | list[str] | OpenTopoKeyPool) -> str:
    """Fetch DEM, using the local cache first (never redownload valid data).

    Accepts a single key (legacy), a list of keys, or an OpenTopoKeyPool.
    With several keys, quota/invalid/rate-limit failures rotate to the next
    key instead of retrying the exhausted one. Permanent per-site errors
    (bad bbox, no dataset coverage) are NOT hidden: they raise OTError
    with kind dataset_unavailable/unknown after all keys agree.
    """
    if isinstance(api_key, OpenTopoKeyPool):
        pool = api_key
    elif isinstance(api_key, (list, tuple)):
        pool = OpenTopoKeyPool(list(api_key))
    else:
        pool = OpenTopoKeyPool(_split_keys(api_key))
    if len(pool) == 0:
        raise OTError("invalid_key", "No OpenTopography API key configured.")
    west, south, east, north = bbox
    cache = _cache_dir()
    last_error: OTError | None = None
    retriable_kinds: set[str] = set()  # failure kinds seen that merit key rotation
    for demtype in ("COP30", "SRTMGL1"):
        cached = cache / _cache_key(bbox, demtype)
        if cached.exists() and _cached_dem_valid(cached):
            print(f"[dem] cache hit: {cached.name}")
            out_path.write_bytes(cached.read_bytes())
            return f"OpenTopography:{demtype}+cached"
        params_base = {
            "demtype": demtype,
            "south": south, "north": north, "west": west, "east": east,
            "outputFormat": "GTiff",
        }
        tried_this_dataset = 0
        while pool.has_usable_key():
            idx = pool.next_index()
            if idx is None:
                break
            tried_this_dataset += 1
            params = dict(params_base, API_Key=pool._keys[idx])
            r = _ot_get(params)
            # Success = TIFF bytes (magic II*\0 or MM\0*); errors are JSON/text.
            # NOTE: do not trust Content-Type — it is not always image/tiff.
            body = r.content
            is_tiff = (r.status_code == 200 and len(body) > 4
                       and (body[:4] in (b"II*\x00", b"MM\x00*")))
            if is_tiff:
                cached.write_bytes(body)
                out_path.write_bytes(body)
                if tried_this_dataset > 1 or demtype != "COP30":
                    print(f"[dem] success with key #{idx + 1} ({demtype})")
                return f"OpenTopography:{demtype}"
            kind = _classify_ot_response(r.status_code, r.text)
            msg = (f"[dem] {demtype} with key #{idx + 1} failed "
                   f"({r.status_code}, kind={kind}): {r.text[:200]}")
            print(msg, file=sys.stderr)
            if kind in ("invalid_key", "quota_exceeded", "rate_limited"):
                # Rotate: retire/cool-down this key, try the next one.
                pool.report(idx, kind)
                last_error = OTError(kind, msg)
                retriable_kinds.add(kind)
                continue
            # dataset_unavailable / unknown → try the next dataset (same keys).
            last_error = OTError(kind, msg)
            break
        # No usable key left, or this dataset failed permanently → next dataset
        # reuses whatever keys are still usable.
    if not pool.has_usable_key() and last_error is not None and retriable_kinds:
        kind = last_error.kind  # every key is retired or cooling down
        raise OTError(kind, f"All {len(pool)} OpenTopography API key(s) "
                            f"unusable (last: {kind}). {last_error}")
    raise OTError("dataset_unavailable",
                  f"OpenTopography requests failed for COP30 and SRTMGL1. "
                  f"Last: {last_error}")


def synthetic_dem(bbox, out_path: Path, size: int = 256) -> str:
    """Offline stand-in: ridged hill + valley, GeoTIFF EPSG:4326."""
    import rasterio
    from rasterio.transform import from_bounds
    west, south, east, north = bbox
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    xn, yn = xx / (size - 1), yy / (size - 1)
    # row 0 = north edge
    hill = 320 * np.exp(-(((xn - 0.35) ** 2) / 0.02 + ((yn - 0.4) ** 2) / 0.05))
    ridge = 180 * np.exp(-(((xn - 0.62) ** 2) / 0.004)) * (0.5 + 0.5 * np.sin(yn * 9))
    base = 600 + 120 * xn + 60 * yn
    elev = base + hill + ridge
    transform = from_bounds(west, south, east, north, size, size)
    with rasterio.open(out_path, "w", driver="GTiff", height=size, width=size,
                       count=1, dtype="float32", crs="EPSG:4326", transform=transform,
                       nodata=-9999) as dst:
        dst.write(elev.astype(np.float32), 1)
    return "SYNTHETIC_DEMO"


# --------------------------------------------------------------------------
# Stage 2: DEM processing
# --------------------------------------------------------------------------

def fill_nodata_nearest(arr: np.ndarray, nodata_mask: np.ndarray) -> np.ndarray:
    if not nodata_mask.any():
        return arr
    try:
        from scipy.ndimage import distance_transform_edt
        _, indices = distance_transform_edt(nodata_mask, return_indices=True)
        filled = arr.copy()
        filled[nodata_mask] = arr[tuple(indices[:, nodata_mask])]
        return filled
    except Exception:
        filled = arr.copy()
        filled[nodata_mask] = np.nanmean(arr[~nodata_mask]) if (~nodata_mask).any() else 0.0
        return filled


def process_dem(dem_path: Path) -> dict:
    import rasterio
    with rasterio.open(dem_path) as src:
        arr = src.read(1).astype(np.float64)
        nodata = src.nodata
        bounds = src.bounds
        crs = str(src.crs)
        transform = src.transform
    mask = np.zeros_like(arr, dtype=bool)
    if nodata is not None:
        mask = (arr == nodata) | ~np.isfinite(arr)
    else:
        mask = ~np.isfinite(arr)
    arr = fill_nodata_nearest(arr, mask)
    return {
        "elevation": arr,  # rows: 0=north … H-1=south; cols: 0=west … W-1=east
        "rows": arr.shape[0], "cols": arr.shape[1],
        "min_m": float(arr.min()), "max_m": float(arr.max()),
        "mean_m": float(arr.mean()),
        "bbox": [bounds.left, bounds.bottom, bounds.right, bounds.top],
        "crs": crs,
        "transform": [transform.a, transform.b, transform.c,
                      transform.d, transform.e, transform.f],
        "nodata_filled": bool(mask.any()),
    }


# --------------------------------------------------------------------------
# Stage 3: satellite texture (Esri World Imagery, warped to DEM grid)
# --------------------------------------------------------------------------

def fetch_texture_esri(bbox, rows: int, cols: int, out_path: Path) -> str:
    import rasterio
    from rasterio.warp import reproject, Resampling
    west, south, east, north = bbox
    # Esri export caps at ~2048px; request a reasonable size then warp to DEM grid.
    req_w, req_h = min(cols, 2048), min(rows, 2048)
    # Esri export bbox order: xmin,ymin,xmax,ymax
    params = {
        "bbox": f"{west},{south},{east},{north}",
        "bboxSR": "4326", "imageSR": "4326",
        "size": f"{req_w},{req_h}",
        "format": "png32", "f": "image",
    }
    r = requests.get(ESRI_EXPORT_URL, params=params, timeout=120)
    r.raise_for_status()
    tmp = out_path.with_suffix(".esri_raw.png")
    tmp.write_bytes(r.content)
    from PIL import Image
    # Esri `f=image` returns a plain (non-georeferenced) PNG for the exact
    # bbox we asked for, so aligning = resize to the DEM grid. If Esri ever
    # returns a georeferenced raster, prefer a proper rasterio warp instead.
    try:
        import rasterio as rio
        from rasterio.transform import from_bounds
        dst_transform = from_bounds(west, south, east, north, cols, rows)
        with rio.open(tmp) as src:
            if src.transform.is_identity:
                raise ValueError("non-georeferenced PNG")
            rgb = np.zeros((3, rows, cols), dtype=np.uint8)
            for b in range(min(3, src.count)):
                reproject(rasterio.band(src, b + 1), rgb[b],
                          src_transform=src.transform, src_crs="EPSG:4326",
                          dst_transform=dst_transform, dst_crs="EPSG:4326",
                          resampling=Resampling.bilinear)
        Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB").save(out_path)
    except Exception:
        # Plain PNG for our bbox: resize is exactly the right alignment.
        img = Image.open(tmp).convert("RGB").resize((cols, rows), Image.BILINEAR)
        img.save(out_path)
    tmp.unlink(missing_ok=True)
    return "Esri:World_Imagery"


def synthetic_texture(rows: int, cols: int, out_path: Path) -> str:
    """Offline stand-in: green-brown gradient with noise + river streak."""
    from PIL import Image
    yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float64)
    xn, yn = xx / max(cols - 1, 1), yy / max(rows - 1, 1)
    rng = np.random.default_rng(7)
    r = (120 + 60 * xn + 20 * np.sin(yn * 12) + rng.normal(0, 8, (rows, cols))).clip(0, 255)
    g = (150 - 40 * xn + 15 * np.cos(xn * 10) + rng.normal(0, 8, (rows, cols))).clip(0, 255)
    b = (100 - 30 * yn + rng.normal(0, 8, (rows, cols))).clip(0, 255)
    river = np.abs(xn - (0.45 + 0.1 * np.sin(yn * 6))) < 0.015
    r[river], g[river], b[river] = 70, 130, 180
    Image.fromarray(np.stack([r, g, b], -1).astype(np.uint8), "RGB").save(out_path)
    return "SYNTHETIC_DEMO"


# --------------------------------------------------------------------------
# Stage 4: mesh + GLB export (trimesh, embedded texture)
# --------------------------------------------------------------------------

def downsample_grid(arr: np.ndarray, mesh_size: int) -> np.ndarray:
    h, w = arr.shape
    sy = max(1, math.ceil(h / mesh_size))
    sx = max(1, math.ceil(w / mesh_size))
    return arr[::sy, ::sx]


def build_mesh_export_glb(elev: np.ndarray, bbox, center: tuple[float, float],
                          texture_path: Path, glb_path: Path,
                          exaggeration: float = 1.0) -> dict:
    import trimesh
    from PIL import Image
    from trimesh.visual import TextureVisuals
    from trimesh.visual.material import PBRMaterial

    west, south, east, north = bbox
    clat, clon = center
    h, w = elev.shape
    # meters-per-degree at site latitude
    m_per_deg_lat = 110540.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(clat))
    xs = (np.linspace(west, east, w) - clon) * m_per_deg_lon   # east offsets
    ys = (np.linspace(north, south, h) - clat) * m_per_deg_lat  # north offsets (row0=north)
    E, N = np.meshgrid(xs, ys)
    h_center = float(elev.mean())
    H = (elev - h_center) * exaggeration

    # Y-up glTF frame: x=E, y=U, z=-N
    verts = np.column_stack([E.ravel(), H.ravel(), (-N).ravel()]).astype(np.float64)
    idx = np.arange(h * w, dtype=np.int64).reshape(h, w)
    q00, q01 = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel()
    q10, q11 = idx[1:, :-1].ravel(), idx[1:, 1:].ravel()
    faces = np.vstack([np.column_stack([q00, q10, q11]),
                       np.column_stack([q00, q11, q01])]).astype(np.int64)

    # UVs: u increases east, v increases south->north-safe (v=1 at north row)
    uu, vv = np.meshgrid(np.linspace(0, 1, w), np.linspace(1, 0, h))
    uv = np.column_stack([uu.ravel(), vv.ravel()]).astype(np.float64)

    image = Image.open(texture_path).convert("RGB")
    material = PBRMaterial(name="terrain",
                           baseColorTexture=image,
                           metallicFactor=0.0,
                           roughnessFactor=1.0)
    mesh = trimesh.Trimesh(vertices=verts, faces=faces,
                           visual=TextureVisuals(uv=uv, material=material, image=image),
                           process=False)
    # ensure normals exist for lighting
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


# --------------------------------------------------------------------------
# Verification: placement sanity (no Cesium needed)
# --------------------------------------------------------------------------

def verify_placement(glb_path: Path, transform: dict, tolerance_m: float = 50.0) -> dict:
    """Check: mesh center maps (via modelMatrix) onto the globe surface at
    center_elevation; mesh corners stay within tolerance of ellipsoid+DEM range."""
    import trimesh
    scene_or_mesh = trimesh.load(glb_path, force="mesh")
    if isinstance(scene_or_mesh, trimesh.Scene):
        geoms = list(scene_or_mesh.geometry.values())
        mesh = geoms[0] if geoms else None
    else:
        mesh = scene_or_mesh
    if mesh is None:
        raise RuntimeError("GLB contains no geometry")
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    M = np.array(transform["modelMatrix_columnMajor"], dtype=np.float64).reshape(4, 4, order="F")
    v4 = np.column_stack([verts, np.ones(len(verts))])
    ecef = (M @ v4.T).T[:, :3]
    radii = np.linalg.norm(ecef, axis=1)
    # expected radius: ellipsoid surface + local elevation at each vertex
    lat0 = transform["lat"]
    ecef_center = lla_to_ecef(transform["lat"], transform["lon"], transform["center_elevation_m"])
    r_center = float(np.linalg.norm(ecef_center))
    ex = float(transform["vertical_exaggeration"])
    # local Y (up) per vertex *should* equal relative elev * exaggeration
    local_up = verts[:, 1]
    expected = r_center + local_up  # approx (radial ~= up for small tiles)
    err = np.abs(radii - expected)
    result = {
        "mesh_vertices": len(verts),
        "max_radial_error_m": float(err.max()),
        "mean_radial_error_m": float(err.mean()),
        "center_radius_m": r_center,
        "passes": bool(err.max() <= tolerance_m),
        "tolerance_m": tolerance_m,
    }
    return result


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Dam-site terrain-to-glTF pipeline")
    p.add_argument("--dam", help='Dam name from dams.json, e.g. "Tehri Dam"')
    p.add_argument("--lat", type=float, help="Site latitude (override/custom site)")
    p.add_argument("--lon", type=float, help="Site longitude (override/custom site)")
    p.add_argument("--name", help="Site name when using --lat/--lon")
    p.add_argument("--radius-km", type=float, default=None, help="BBox half-size in km")
    p.add_argument("--mesh-size", type=int, default=256, help="Max mesh grid dim (default 256)")
    p.add_argument("--exaggeration", type=float, default=1.0, help="Vertical exaggeration (1.0 = true scale)")
    p.add_argument("--output-dir", default=None, help="Output root (default 3d-assets/terrain-pipeline/output)")
    p.add_argument("--demo", action="store_true", help="Offline mode: synthetic DEM + texture")
    p.add_argument("--opentopo-key", default=None,
                     help="OpenTopography API key(s): single key or comma/space-separated "
                          "list for rotation (else $OPENTOPOGRAPHY_API_KEY* / $OPENTOPO_KEYS)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    site = resolve_site(args.dam, args.lat, args.lon, args.radius_km, args.name)
    bbox = bbox_from_center(site["lat"], site["lon"], site["radius_km"])
    west, south, east, north = bbox

    out_root = Path(args.output_dir) if args.output_dir else OUTPUT_ROOT
    out_dir = out_root / safe_dirname(site["name"])
    out_dir.mkdir(parents=True, exist_ok=True)
    dem_path = out_dir / "dem_raw.tif"
    tex_path = out_dir / "texture.png"
    glb_path = out_dir / f"{safe_dirname(site['name'])}.glb"

    print(f"[stage 0] site={site['name']} lat={site['lat']} lon={site['lon']} r={site['radius_km']}km")
    print(f"[stage 0] bbox W={west:.5f} S={south:.5f} E={east:.5f} N={north:.5f}")

    # ---- Stage 1: DEM ----
    keys = collect_opentopo_keys(args.opentopo_key)
    dem_source = ""
    if args.demo or not keys:
        if not args.demo:
            print("[stage 1] no OpenTopography API key "
                  "($OPENTOPOGRAPHY_API_KEY[_N] / $OPENTOPO_KEYS / --opentopo-key) — "
                  "using synthetic DEM (pass --demo to silence).",
                  file=sys.stderr)
        dem_source = synthetic_dem(bbox, dem_path)
        print(f"[stage 1] synthetic DEM -> {dem_path}")
    else:
        print(f"[stage 1] {len(keys)} OpenTopography key(s) configured; "
              f"rotating on quota/rate-limit failures.")
        try:
            dem_source = fetch_dem_opentopo(bbox, dem_path, keys)
            print(f"[stage 1] DEM ({dem_source}) -> {dem_path}")
        except OTError as e:
            # Classified failure: log the kind (key/quota/rate/network/...)
            # so batch runners can record it instead of retrying blindly.
            print(f"[stage 1] OpenTopography {e.kind}: {e}; "
                  f"falling back to synthetic DEM.", file=sys.stderr)
            dem_source = synthetic_dem(bbox, dem_path) + f"+FALLBACK:{e.kind}"
        except Exception as e:
            print(f"[stage 1] OpenTopography failed ({e}); falling back to synthetic DEM.", file=sys.stderr)
            dem_source = synthetic_dem(bbox, dem_path) + "+FALLBACK:unknown"

    # ---- Stage 2: process ----
    dem = process_dem(dem_path)
    print(f"[stage 2] grid={dem['rows']}x{dem['cols']} elev_min={dem['min_m']:.1f}m "
          f"max={dem['max_m']:.1f}m mean={dem['mean_m']:.1f}m crs={dem['crs']}")

    # ---- Stage 3: texture ----
    tex_source = ""
    if args.demo:
        tex_source = synthetic_texture(dem["rows"], dem["cols"], tex_path)
        print(f"[stage 3] synthetic texture -> {tex_path}")
    else:
        try:
            tex_source = fetch_texture_esri(dem["bbox"], dem["rows"], dem["cols"], tex_path)
            print(f"[stage 3] texture ({tex_source}) -> {tex_path}")
        except Exception as e:
            print(f"[stage 3] Esri fetch failed ({e}); using synthetic texture.", file=sys.stderr)
            tex_source = synthetic_texture(dem["rows"], dem["cols"], tex_path) + "+FALLBACK"

    # ---- Stage 4: mesh + GLB ----
    elev_small = downsample_grid(dem["elevation"], args.mesh_size)
    mesh_info = build_mesh_export_glb(elev_small, dem["bbox"], (site["lat"], site["lon"]),
                                      tex_path, glb_path, args.exaggeration)
    print(f"[stage 4] mesh v={mesh_info['vertices']} f={mesh_info['faces']} "
          f"extent={mesh_info['width_m']:.0f}x{mesh_info['height_m']:.0f}m -> {glb_path}")

    model_matrix = build_model_matrix(site["lat"], site["lon"], mesh_info["center_elevation_m"])
    ecef_center = lla_to_ecef(site["lat"], site["lon"], mesh_info["center_elevation_m"])

    transform = {
        "dam": site["name"],
        "lat": site["lat"],
        "lon": site["lon"],
        "center_elevation_m": mesh_info["center_elevation_m"],
        "vertical_exaggeration": float(args.exaggeration),
        "local_frame": "Y-up: x=east(m), y=up-relative-to-center(m, exaggerated), z=south(m, i.e. -north)",
        "placement": "Cesium: Model.fromGltf({url, modelMatrix}) with modelMatrix below; "
                     "or entity position=center_ecef + orientation from matrix rotation.",
        "center_ecef_m": [float(v) for v in ecef_center],
        "modelMatrix_columnMajor": [float(v) for v in model_matrix.reshape(-1, order="F")],
        "modelMatrix_rowMajor": [float(v) for v in model_matrix.reshape(-1, order="C")],
        "mesh_extent_m": {"width_east_west": mesh_info["width_m"],
                          "height_north_south": mesh_info["height_m"]},
        "glb": glb_path.name,
    }
    (out_dir / "transform.json").write_text(json.dumps(transform, indent=2), encoding="utf-8")

    metadata = {
        "dam": site["name"],
        "lat": site["lat"], "lon": site["lon"],
        "bbox_radius_km": site["radius_km"],
        "bbox_wsen": dem["bbox"],
        "crs": dem["crs"],
        "elevation_min_m": dem["min_m"],
        "elevation_max_m": dem["max_m"],
        "elevation_mean_m": dem["mean_m"],
        "nodata_filled": dem["nodata_filled"],
        "dem_grid": {"rows": dem["rows"], "cols": dem["cols"]},
        "mesh_grid": {"rows": elev_small.shape[0], "cols": elev_small.shape[1]},
        "vertical_exaggeration": float(args.exaggeration),
        "sources": {"dem": dem_source, "texture": tex_source},
        "created_utc": datetime.now(timezone.utc).isoformat(),
    }
    (out_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    # ---- Verify ----
    check = verify_placement(glb_path, transform)
    print(f"[verify] verts={check['mesh_vertices']} max_radial_err={check['max_radial_error_m']:.2f}m "
          f"mean={check['mean_radial_error_m']:.2f}m -> {'PASS' if check['passes'] else 'FAIL'}")
    (out_dir / "verification.json").write_text(json.dumps(check, indent=2), encoding="utf-8")
    if not check["passes"]:
        print("[verify] FAIL: model does not sit on globe within tolerance.", file=sys.stderr)
        return 2
    print(f"[done] output dir: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
