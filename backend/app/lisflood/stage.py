"""DamSafe Twin — LISFLOOD-FP terrain staging.

Pipeline: repo DEM (EPSG:4326 GeoTIFF) -> metric UTM crop around the dam ->
Arc ASCII inputs for LISFLOOD-FP.

CRS discipline (never treat degrees as metres):
- source DEM stays EPSG:4326 on read;
- the simulation grid is reprojected to the dam's UTM zone (EPSG:326xx,
  northern hemisphere) at the requested metric cell size;
- every derived product records {crs, transform, shape} in metadata so the
  frontend can map result cells back to lon/lat and to the GLB local frame.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import Resampling, calculate_default_transform, reproject
from rasterio.warp import transform as warp_transform
from scipy import ndimage

from app.sandbox.dam_registry import get_dam
from app.sandbox.terrain import locate_dem


def fill_nearest(a: np.ndarray) -> np.ndarray:
    """Fill NaN voids with the nearest valid pixel (deterministic)."""
    mask = np.isnan(a)
    if not bool(mask.any()):
        return a
    if bool(mask.all()):
        raise ValueError("grid is entirely void")
    inds = ndimage.distance_transform_edt(mask, return_indices=True, return_distances=False)
    filled = a.copy()
    filled[mask] = a[tuple(inds)][mask]
    return filled


@dataclass
class Domain:
    dam_id: str
    dam_name: str
    dam_lon: float
    dam_lat: float
    dam_height_m: float | None
    dem_path: str
    src_crs: str
    dst_crs: str
    utm_zone: int
    cell_m: float
    nrows: int
    ncols: int
    west: float      # UTM of grid left edge
    north: float     # UTM of grid top edge
    elev: np.ndarray  # (rows, cols) float64, row0 = north
    dam_easting: float
    dam_northing: float
    dam_row: int
    dam_col: int
    # Valley direction from steepest-descent trace, metric unit vector
    # (east, north). Upstream = -downstream.
    downstream_east: float
    downstream_north: float


def utm_epsg(lon: float, lat: float) -> tuple[int, str]:
    zone = int((lon + 180.0) // 6.0) + 1
    epsg = (32600 if lat >= 0 else 32700) + zone
    return zone, f"EPSG:{epsg}"


def _shift_lonlat(lon: float, lat: float, dx_m: float, dy_m: float) -> tuple[float, float]:
    """Shift a lon/lat point by metric offsets (small-domain equirectangular)."""
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    return lon + dx_m / (111320.0 * cos_lat), lat + dy_m / 110540.0


def _trace_direction(dem_path: str, lon: float, lat: float, radius_km: float) -> tuple[float, float]:
    """Find the downstream valley direction at the dam by steepest descent.

    Reads a coarse native-resolution crop, walks downhill from the dam cell,
    and returns a metric unit vector (east, north). Falls back to an 8-ray
    max-drop search when the walk stalls immediately (flat/ pit cells).
    """
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    dx_deg = radius_km / (111.32 * cos_lat)
    dy_deg = radius_km / 110.54
    bbox = (lon - dx_deg, lat - dy_deg, lon + dx_deg, lat + dy_deg)
    with rasterio.open(dem_path) as src:
        window = rasterio.windows.from_bounds(*bbox, transform=src.transform)
        window = window.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        a = src.read(1, window=window).astype(np.float64)
        if src.nodata is not None:
            a = np.where(a == src.nodata, np.nan, a)
    if bool(np.isnan(a).any()):
        a = fill_nearest(a)
    rows, cols = a.shape
    # Rasterio row0 = north edge: row index grows southward.
    r0 = min(max(rows - 1 - int((lat - bbox[1]) / (bbox[3] - bbox[1]) * rows), 1), rows - 2)
    c0 = min(max(int((lon - bbox[0]) / (bbox[2] - bbox[0]) * cols), 1), cols - 2)
    m_per_col = (bbox[2] - bbox[0]) / cols * 111320.0 * cos_lat
    m_per_row = (bbox[3] - bbox[1]) / rows * 110540.0

    # Steepest-descent walk.
    r, c = r0, c0
    for _ in range(200):
        best = None
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols:
                    if best is None or a[nr, nc] < best[0]:
                        best = (a[nr, nc], nr, nc)
        if best is None or best[0] >= a[r, c] - 1e-6:
            break
        r, c = best[1], best[2]
        if r in (0, rows - 1) or c in (0, cols - 1):
            break

    if abs(c - c0) + abs(r - r0) >= 3:
        mx = (c - c0) * m_per_col
        my = -(r - r0) * m_per_row  # rows grow southward -> north is negative
    else:
        # Stalled (flat/pit): 8-ray max-drop search at ~1/6 of crop extent.
        step = max(4, min(rows, cols) // 6)
        drops = []
        for k in range(8):
            ang = k * math.pi / 4  # 0 = east, measured toward north
            nc = int(round(c0 + math.cos(ang) * step))
            nr = int(round(r0 - math.sin(ang) * step))
            if 0 <= nr < rows and 0 <= nc < cols:
                drops.append((a[r0, c0] - a[nr, nc], math.cos(ang), math.sin(ang)))
        if not drops:
            return 0.0, -1.0
        drops.sort(reverse=True)  # biggest drop (or smallest rise) first
        mx = drops[0][1] * step * m_per_col
        my = drops[0][2] * step * m_per_row
    norm = math.hypot(mx, my)
    if norm < 1e-9:
        return 0.0, -1.0
    return mx / norm, my / norm


def trace_flow_path(elev: np.ndarray, row: int, col: int, max_steps: int = 400) -> list[tuple[int, int]]:
    """Steepest-descent cell path from the dam (for the UI valley overlay)."""
    rows, cols = elev.shape
    path = [(row, col)]
    r, c = row, col
    seen = {(r, c)}
    for _ in range(max_steps):
        best = None
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols and (nr, nc) not in seen:
                    if best is None or elev[nr, nc] < best[0]:
                        best = (elev[nr, nc], nr, nc)
        if best is None or best[0] >= elev[r, c] - 1e-9:
            break
        r, c = best[1], best[2]
        seen.add((r, c))
        path.append((r, c))
        if r in (0, rows - 1) or c in (0, cols - 1):
            break
    return path


def prepare_domain(dam_id: str, radius_km: float, cell_m: float, bias: float = 0.5) -> Domain:
    """Crop the repo DEM around the dam and reproject to a metric grid.

    The crop centre is shifted downstream (valley-ward) by ``bias`` radii so
    the domain covers the upstream reservoir AND a long downstream valley
    instead of equal dead space in every direction. ``bias=0`` centres on
    the dam (legacy behaviour).
    """
    dam = get_dam(dam_id)
    if dam is None:
        raise FileNotFoundError(f"Unknown dam id '{dam_id}'")
    dem_path = locate_dem(dam_id)
    if dem_path is None:
        raise FileNotFoundError(
            f"No DEM for dam '{dam_id}'. Expected 3d-assets/terrain-pipeline/output/{dam_id}/dem_raw.tif"
        )

    lon, lat = float(dam["lon"]), float(dam["lat"])
    zone, dst_crs = utm_epsg(lon, lat)

    # Pass 1 (coarse): find the downstream valley direction at the dam.
    try:
        ux, uy = _trace_direction(str(dem_path), lon, lat, max(radius_km, 2.0))
    except Exception:
        ux, uy = 0.0, -1.0
    # Pass 2: centre the square crop downstream so the domain holds the
    # upstream reservoir AND a long downstream valley.
    clon, clat = _shift_lonlat(lon, lat, ux * radius_km * 1000.0 * bias,
                               uy * radius_km * 1000.0 * bias)

    cos_lat = max(math.cos(math.radians(clat)), 1e-6)
    dx_deg = radius_km / (111.32 * cos_lat)
    dy_deg = radius_km / 110.54
    bbox = (clon - dx_deg, clat - dy_deg, clon + dx_deg, clat + dy_deg)

    with rasterio.open(dem_path) as src:
        if src.count < 1:
            raise ValueError(f"DEM has no bands: {dem_path}")
        window = rasterio.windows.from_bounds(*bbox, transform=src.transform)
        # Clamp window to raster (round outward, then intersect).
        window = window.round_offsets().round_shape()
        window = window.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        if window.width < 4 or window.height < 4:
            raise ValueError(f"Dam {dam_id} maps outside its DEM coverage")
        arr = src.read(1, window=window).astype(np.float64)
        src_transform = src.window_transform(window)
        src_crs = str(src.crs or "EPSG:4326")
        nodata = src.nodata

    if nodata is not None:
        arr = np.where(arr == nodata, np.nan, arr)
    # Source DEMs are full-coverage; fill any residual voids deterministically.
    if bool(np.isnan(arr).any()):
        arr = fill_nearest(arr)
    if not bool(np.isfinite(arr).all()):
        raise ValueError("DEM contains non-finite values after void filling")
    if bool((arr <= -500).any()) or bool((arr > 9000).any()):
        raise ValueError("DEM elevations outside plausible range (-500..9000 m)")

    # Metric destination grid covering the crop bbox.
    west_m, south_m, east_m, north_m = rasterio.warp.transform_bounds(
        "EPSG:4326", dst_crs, *bbox, densify_pts=21
    )
    ncols = max(8, int(math.ceil((east_m - west_m) / cell_m)))
    nrows = max(8, int(math.ceil((north_m - south_m) / cell_m)))
    # Re-anchor to exact multiples so cell size is honoured precisely.
    east_m = west_m + ncols * cell_m
    south_m = north_m - nrows * cell_m
    dst_transform = rasterio.transform.from_origin(west_m, north_m, cell_m, cell_m)

    metric = np.full((nrows, ncols), np.nan, dtype=np.float64)
    reproject(
        arr,
        metric,
        src_transform=src_transform,
        src_crs="EPSG:4326",
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        resampling=Resampling.bilinear,
        dst_nodata=float("nan"),
    )
    if bool(np.isnan(metric).any()):
        metric = fill_nearest(metric)
    if not bool(np.isfinite(metric).all()):
        raise ValueError("Reprojected DEM has unfillable voids")

    # Dam position in grid coords.
    (de,), (dn,) = warp_transform("EPSG:4326", dst_crs, [lon], [lat])
    col = int((de - west_m) / cell_m)
    row = int((north_m - dn) / cell_m)
    if not (1 <= col < ncols - 1 and 1 <= row < nrows - 1):
        raise ValueError(
            f"Dam {dam_id} falls outside the downstream-shifted domain "
            f"(cell {col},{row} of {ncols}x{nrows}). Increase domain_radius_km."
        )

    return Domain(
        dam_id=dam_id,
        dam_name=str(dam.get("name", dam_id)),
        dam_lon=lon,
        dam_lat=lat,
        dam_height_m=dam.get("height_m"),
        dem_path=str(dem_path),
        src_crs=src_crs,
        dst_crs=dst_crs,
        utm_zone=zone,
        cell_m=cell_m,
        nrows=nrows,
        ncols=ncols,
        west=west_m,
        north=north_m,
        elev=np.ascontiguousarray(metric),
        dam_easting=de,
        dam_northing=dn,
        dam_row=row,
        dam_col=col,
        downstream_east=ux,
        downstream_north=uy,
    )


def write_asc(path: Path, arr: np.ndarray, west: float, north: float, cell_m: float) -> None:
    """Arc ASCII grid, row0 = north edge. LISFLOOD map units = file units (metres)."""
    nrows, ncols = arr.shape
    yll = north - nrows * cell_m
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"ncols         {ncols}\n")
        f.write(f"nrows         {nrows}\n")
        f.write(f"xllcorner     {west:.3f}\n")
        f.write(f"yllcorner     {yll:.3f}\n")
        f.write(f"cellsize      {cell_m:.3f}\n")
        f.write("NODATA_value  -9999\n")
        np.savetxt(f, arr, fmt="%.3f")


def read_asc(path: Path) -> tuple[np.ndarray, dict]:
    """Parse Arc ASCII grid -> (array float64 row0=north, header dict)."""
    header: dict = {}
    with open(path, "r", encoding="utf-8") as f:
        for _ in range(6):
            key, val = f.readline().split(None, 1)
            header[key.lower()] = float(val) if "." in val or "e" in val.lower() or "-" in val else int(val)
        arr = np.loadtxt(f, dtype=np.float64)
    nrows, ncols = int(header["nrows"]), int(header["ncols"])
    if arr.shape != (nrows, ncols):
        raise ValueError(f"{path.name}: shape {arr.shape} != header {(nrows, ncols)}")
    return arr, header


def weir_axis_for(downstream_east: float, downstream_north: float) -> str:
    """Weir link axis along the valley direction ('E' = Qx link, else 'N').

    Unfixed direction: flow is driven by the reservoir head either way; the
    axis only decides which cell faces the link crosses at the dam.
    """
    return "E" if abs(downstream_east) >= abs(downstream_north) else "N"
