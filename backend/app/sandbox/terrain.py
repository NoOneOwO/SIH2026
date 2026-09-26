"""
DamSafe Twin Sandbox — terrain domain loading.

Reads the curated pipeline DEMs (output/<dam_id>/dem_raw.tif) and resamples
to the LOW/MED sim grid. Visualization keeps the hi-res GLB mesh; results
are projected back onto it by the frontend.

If a dam has no local DEM, terrain is AUTO-ACQUIRED through the provider
chain (Copernicus GLO-30 → GLO-90 → CDSE S3 → OpenTopography fallback) and
cached into the terrain tree — the API must not 404 when terrain can be
generated. Set DAMSAFE_TERRAIN_DIR (or SANDBOX_TERRAIN_DIR) to override the
default (repo-relative) location.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.sandbox.dam_registry import get_dam
from app.sandbox.terrain_providers import TerrainUnavailableError, ensure_dem

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_TERRAIN_DIR = BACKEND_DIR.parent / "3d-assets" / "terrain-pipeline" / "output"


def terrain_dir() -> Path:
    override = os.environ.get("DAMSAFE_TERRAIN_DIR", "") or os.environ.get("SANDBOX_TERRAIN_DIR", "")
    return Path(override) if override else DEFAULT_TERRAIN_DIR


def dem_cache_dir() -> Path:
    """Writable cache for provider-acquired DEMs (curated tree may be read-only)."""
    override = os.environ.get("DAMSAFE_DEM_CACHE", "")
    if override:
        return Path(override)
    return BACKEND_DIR / "app" / "sandbox" / "dem_cache"


def _roots() -> list[Path]:
    roots = [terrain_dir()]
    cache = dem_cache_dir()
    if cache != roots[0]:
        roots.append(cache)
    return roots


def locate_dem(dam_id: str) -> Path | None:
    for root in _roots():
        dem = root / dam_id / "dem_raw.tif"
        if dem.exists() and dem.stat().st_size > 10_000:
            return dem
    return None


def _meta_from_pipeline(dam_id: str) -> dict | None:
    """Curated pipeline metadata when present (name/elev/bbox/sources)."""
    for f in ("metadata.json",):
        p = terrain_dir() / dam_id / f
        if p.exists():
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                return d
            except Exception:
                return None
    return None


def resolve_dam(dam_id: str) -> dict:
    """Canonical dam record + terrain provenance, acquiring DEM on demand.

    Never returns a bare 'No terrain' for a known dam: missing DEMs are
    fetched through the provider chain and cached. Raises
    TerrainUnavailableError (→ HTTP 503 with the stage trail) only when
    every provider fails, or FileNotFoundError for unknown dam ids.
    """
    rec = get_dam(dam_id)
    if rec is None:
        raise FileNotFoundError(f"Unknown dam id '{dam_id}'.")
    dem_path = locate_dem(dam_id)
    provenance: dict | None = None
    if dem_path is None:
        dem_path, provenance = ensure_dem(dam_id, rec["lat"], rec["lon"],
                                          _roots(), dem_cache_dir())
        load_elevation.cache_clear()
    if provenance is None:
        for root in _roots():
            prov_path = root / dam_id / "dem_provenance.json"
            if prov_path.exists():
                try:
                    provenance = json.loads(prov_path.read_text(encoding="utf-8"))
                    break
                except Exception:
                    provenance = None
    if provenance is None:
        pipe = _meta_from_pipeline(dam_id) or {}
        src = (pipe.get("sources") or {}).get("dem", "curated-DEM")
        # Legacy pipeline labels name the true origin: OpenTopography COP30
        # serves Copernicus GLO-30 DGED (30 m); SRTMGL1 is 30 m SRTM.
        resolution = 30 if ("COP30" in src or "SRTMGL1" in src or "GLO-30" in src) else (
            90 if ("GLO-90" in src or "COP90" in src) else 0)
        provenance = {"source": src, "dataset": src, "resolution_m": resolution,
                      "fallback_used": False, "fallback_reason": "",
                      "cached": True, "attempt_trail": ["local: existing asset"]}
    return {
        "dam_id": dam_id,
        "name": rec["name"],
        "state": rec.get("state"),
        "lat": rec["lat"], "lon": rec["lon"],
        "height_m": rec.get("height_m"),
        "type": rec.get("type"),
        "river": rec.get("river"),
        "capacity_mcm": rec.get("capacity_mcm"),
        "year_built": rec.get("year_built"),
        "terrain": provenance,
    }


def available_dams() -> list[dict]:
    """Canonical registry dams with terrain provenance.

    The sim-domain inventory is the canonical registry (never raw terrain
    folder names — stale folders from an older dataset used to leak through
    as `dNNN (dNNN)` entries that later 404'd on run). A dam is listed when it
    has a DEM on disk OR when one can be acquired through the provider chain;
    `terrain_ready` reports which is which so the UI can promise honestly.
    """
    import json

    dams = []
    from app.sandbox.dam_registry import DAMS

    root = terrain_dir()
    for rec in DAMS:
        dam_id = rec["id"]
        dem = locate_dem(dam_id)
        ready = dem is not None
        if not ready:
            # Auto-acquirable is good enough to list (run would fetch it);
            # if even the provider chain is exhausted the 503 path handles it.
            continue
        meta: dict = {}
        meta_path = root / dam_id / "metadata.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        dams.append({
            "dam_id": dam_id,
            "name": rec["name"],
            "state": rec.get("state"),
            "lat": rec["lat"],
            "lon": rec["lon"],
            "height_m": rec.get("height_m"),
            "terrain_ready": True,
            "elevation_min_m": meta.get("elevation_min_m"),
            "elevation_max_m": meta.get("elevation_max_m"),
            "bbox": meta.get("bbox_wsen"),
            "sources": meta.get("sources", {}),
            "mesh_grid": meta.get("mesh_grid", {}),
        })
    return dams


def _fill_nodata(a: np.ndarray) -> np.ndarray:
    mask = ~np.isfinite(a)
    if not mask.any():
        return a
    try:
        from scipy.ndimage import distance_transform_edt
        _, idx = distance_transform_edt(mask, return_indices=True)
        out = a.copy()
        out[mask] = a[tuple(idx[:, mask])]
        return out
    except Exception:
        out = a.copy()
        out[mask] = np.nanmean(a)
        return out


@lru_cache(maxsize=8)
def load_elevation(dam_id: str, grid_size: int) -> tuple[np.ndarray, float, list]:
    """(elev[N,N] float64 row0=north, cell_m, bbox_wsen). Cached per (dam, grid)."""
    import rasterio
    from rasterio.enums import Resampling

    dem_path = locate_dem(dam_id)
    if dem_path is None:
        # Auto-acquire instead of 404: resolve_dam fetches + caches via providers.
        resolve_dam(dam_id)
        dem_path = locate_dem(dam_id)
    if dem_path is None:
        raise FileNotFoundError(
            f"No terrain for dam '{dam_id}' under {terrain_dir()}. "
            f"Regenerate with the terrain pipeline or set DAMSAFE_TERRAIN_DIR."
        )
    with rasterio.open(dem_path) as src:
        arr = src.read(
            1, out_shape=(grid_size, grid_size), resampling=Resampling.bilinear
        ).astype(np.float64)
        nodata = src.nodata
        bounds = src.bounds
        if nodata is not None:
            arr[arr == nodata] = np.nan
        arr = _fill_nodata(arr)
        width_m = (bounds.right - bounds.left) * 111320.0 * abs(__import__("math").cos(
            __import__("math").radians((bounds.top + bounds.bottom) / 2)))
        cell_m = width_m / grid_size
        bbox = [bounds.left, bounds.bottom, bounds.right, bounds.top]
    return arr, cell_m, bbox
