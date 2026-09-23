"""DamSafe Twin — classic-path solver grid codec + exposure sampling.

The Celery classic path (educational SWE) embeds its result grids directly in
``SimRun.result_layers`` as base64 float32 arrays plus a ``grid`` anchor:

    result_layers = {
        "engine": {...},
        "grid": {"origin_lon": .., "origin_lat": .., "cell_m": 10,
                 "nrows": 100, "ncols": 100,
                 "mapping": "screening-1d-downstream"},
        "depth_b64": ..., "velocity_b64": ..., "arrival_min_b64": ...,
    }

Sampling model (documented screening approximation): the educational solver
propagates a 1-D Ritter wave downstream, so a point's hydraulics are a
function of its over-ground distance from the dam (the grid anchor). Lateral
offset is ignored — the grids carry no cross-valley variation. LISFLOOD jobs
carry richer 2-D grids via their own ``/lisflood`` result path; this module
is only for the classic screening grids.
"""

from __future__ import annotations

import base64
import math

import numpy as np

M_PER_DEG = 111320.0


def _b64_decode(s: str, shape: tuple[int, int]) -> np.ndarray:
    raw = base64.b64decode(s.encode())
    return np.frombuffer(raw, dtype=np.float32).reshape(shape).astype(float)


def decode_grids(result_layers: dict | None) -> dict | None:
    """Decode embedded grids from a SimRun.result_layers payload.

    Returns ``{"depth": ..., "velocity": ..., "arrival_min": ..., "meta": ...}``
    or ``None`` when the run carries no grids (old / failed / foreign runs).
    """
    if not isinstance(result_layers, dict):
        return None
    meta = result_layers.get("grid")
    try:
        nrows = int(meta["nrows"])
        ncols = int(meta["ncols"])
        shape = (nrows, ncols)
        depth = _b64_decode(result_layers["depth_b64"], shape)
        velocity = _b64_decode(result_layers["velocity_b64"], shape)
        arrival = _b64_decode(result_layers["arrival_min_b64"], shape)
    except (KeyError, TypeError, ValueError):
        return None
    return {"depth": depth, "velocity": velocity, "arrival_min": arrival, "meta": dict(meta)}


def overground_distance_m(lon0: float, lat0: float, lon: float, lat: float) -> float:
    """Equirectangular over-ground distance (metres). Screening-grade."""
    dx = (lon - lon0) * M_PER_DEG * math.cos(math.radians(lat0))
    dy = (lat - lat0) * M_PER_DEG
    return math.hypot(dx, dy)


def sample_point(grids: dict, lon: float, lat: float) -> dict:
    """Sample depth/velocity/arrival at a lon/lat point.

    Maps the point to a downstream-distance row; points beyond the grid edge
    clamp to the last row and are flagged ``outside=True``.
    """
    meta = grids["meta"]
    cell_m = float(meta.get("cell_m") or 10.0)
    nrows = int(meta["nrows"])
    ncols = int(meta["ncols"])
    dist = overground_distance_m(float(meta["origin_lon"]), float(meta["origin_lat"]), lon, lat)
    row = int(round(dist / cell_m)) if cell_m > 0 else 0
    outside = row >= nrows
    row = min(max(row, 0), nrows - 1)
    col = ncols // 2  # centreline: the 1-D wave has no cross-valley variation
    depth = float(grids["depth"][row, col])
    velocity = float(grids["velocity"][row, col])
    arrival = float(grids["arrival_min"][row, col])
    return {
        "depth_m": max(0.0, depth),
        "velocity_ms": max(0.0, velocity),
        "arrival_min": arrival if arrival >= 0 else None,
        "distance_m": round(dist, 1),
        "outside": outside,
    }


def summarize(grids: dict) -> dict:
    """Domain aggregates over the embedded grids."""
    depth = grids["depth"]
    velocity = grids["velocity"]
    wet = depth > 0.01
    wet_cells = int(wet.sum())
    return {
        "max_depth_m": round(float(depth.max()), 3) if wet_cells else 0.0,
        "max_velocity_ms": round(float(velocity[wet].max()), 3) if wet_cells else 0.0,
        "wet_cells": wet_cells,
        "nrows": int(depth.shape[0]),
        "ncols": int(depth.shape[1]),
    }
