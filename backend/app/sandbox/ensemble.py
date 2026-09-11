"""
DamSafe Twin Sandbox — ensemble analysis + asset exposure.

Per-location/per-asset aggregation over N runs: % scenarios affected,
earliest/median/worst arrival, max depth, exposure frequency. Impact
classes are explicitly SCENARIO-BASED exposure indicators, not
statistical guarantees:
  High-confidence  >= 70% of scenarios
  Probable          40–70%
  Low-probability   < 40% (but > 0)
"""

from __future__ import annotations

import numpy as np


def classify_exposure(pct: float) -> str:
    if pct >= 70.0:
        return "High-confidence"
    if pct >= 40.0:
        return "Probable"
    if pct > 0.0:
        return "Low-probability"
    return "Not-exposed"


def aggregate_cells(arrivals: list[np.ndarray], depths: list[np.ndarray]) -> dict:
    """Aggregate per-cell over runs. arrival=-1 means dry in that run."""
    A = np.stack(arrivals)  # (R,N,N), minutes
    D = np.stack(depths)    # (R,N,N), meters
    wet = A >= 0
    runs = A.shape[0]
    freq = wet.mean(axis=0) * 100.0
    earliest = np.where(wet, A, np.inf).min(axis=0)
    earliest[~wet.any(axis=0)] = -1.0
    worst = np.where(wet, A, -np.inf).max(axis=0)
    worst[~wet.any(axis=0)] = -1.0
    with np.errstate(invalid="ignore"):
        stacked = np.where(wet, A, np.nan)
        with __import__("warnings").catch_warnings():
            __import__("warnings").simplefilter("ignore", RuntimeWarning)
            median = np.nanmedian(stacked, axis=0)
    median = np.where(np.isnan(median), -1.0, median)
    maxdepth = D.max(axis=0)
    return {
        "exposure_pct": freq.astype(np.float32),
        "earliest_min": earliest.astype(np.float32),
        "median_min": median.astype(np.float32),
        "worst_min": worst.astype(np.float32),
        "maxdepth_m": maxdepth.astype(np.float32),
    }


def asset_exposure(asset: dict, arrival: np.ndarray, depth: np.ndarray,
                   cell_m: float, bbox: list, exposure_pct: float | None = None) -> dict:
    """Sample arrival/depth at an asset's lon/lat (nearest cell)."""
    west, south, east, north = bbox
    n = arrival.shape[0]
    fx = (asset["lon"] - west) / max(east - west, 1e-12)
    fy = (north - asset["lat"]) / max(north - south, 1e-12)  # row0 = north
    c = int(np.clip(round(fx * (n - 1)), 0, n - 1))
    r = int(np.clip(round(fy * (n - 1)), 0, n - 1))
    a = float(arrival[r, c])
    d = float(depth[r, c])
    sev = 0
    if d >= 5.0:
        sev = 4
    elif d >= 2.5:
        sev = 3
    elif d >= 1.0:
        sev = 2
    elif d >= 0.3:
        sev = 1
    out = dict(asset)
    out.update({
        "arrival_min": a if a >= 0 else None,
        "max_depth_m": round(d, 2),
        "severity": sev,
        "exposure_pct": exposure_pct,
        "priority": sev * 10 + (5 if (exposure_pct or 0) >= 70 else 0),
    })
    return out
