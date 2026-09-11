"""
DamSafe Twin Sandbox — shared API response builders.

Single home for severity banding, breach-hydrograph payloads and run
summaries so live endpoints and the offline demo bundle report identical,
honestly-computed fields.
"""

from __future__ import annotations

import math

from app.sandbox import hydrograph as hydro


def severity_band(max_depth_m: float, flooded_area_km2: float, n_critical: int) -> str:
    """Heuristic consequence band for display. Screening indicator, NOT a certified rating."""
    if max_depth_m >= 5.0 or flooded_area_km2 >= 20.0 or n_critical >= 5:
        return "CRITICAL"
    if max_depth_m >= 2.5 or flooded_area_km2 >= 5.0 or n_critical >= 2:
        return "VERY HIGH"
    if max_depth_m >= 1.0 or flooded_area_km2 >= 1.0 or n_critical >= 1:
        return "HIGH"
    return "MODERATE"


def hydrograph_payload(scenario) -> dict:
    formation = hydro.formation_time_min(scenario.breach_severity, scenario.breach_formation_min)
    hg = hydro.compute_hydrograph(
        scenario.breach_width_m, scenario.breach_depth_m,
        scenario.initial_release_m3, formation,
        scenario.duration_min, scenario.timestep_s)
    hg["breach_formation_min"] = round(formation, 1)
    # Downsample long series for transport (shape preserved, ≤121 points).
    n = len(hg["times_min"])
    if n > 121:
        step = math.ceil(n / 121)
        for k in ("times_min", "discharge_m3s", "cumulative_m3"):
            pts = hg[k][::step]
            if pts[-1] != hg[k][-1]:
                pts.append(hg[k][-1])
            hg[k] = pts
    return hg


def summarize(result, assets: list[dict], hydrograph: dict | None = None) -> dict:
    crit = [a for a in assets if a.get("severity", 0) >= 3]
    arrivals = [a["arrival_min"] for a in assets if a.get("arrival_min") is not None]
    downstream = result.maxdepth_m[~result.source_mask]
    peak_depth = round(float(downstream.max(initial=0.0)), 2)
    area = round(result.flooded_area_km2, 3)
    out = {
        "flooded_area_km2": area,
        "flooded_cells": result.flooded_cells,
        "max_depth_anywhere_m": peak_depth,
        "max_depth_note": "Peak outside the 5x5 breach source zone",
        "assets_evaluated": len(assets),
        "assets_critical": len(crit),
        "earliest_asset_arrival_min": round(min(arrivals), 1) if arrivals else None,
        "volume_in_m3": round(result.volume_in_m3, 1),
        "volume_stored_m3": round(result.volume_stored_m3, 1),
        "steps_used": result.steps_used,
        "sim_minutes": round(result.sim_minutes, 1),
        "timesteps": len(result.frames or []),
        "severity_band": severity_band(peak_depth, area, len(crit)),
        "severity_note": "Heuristic screening band (depth/area/critical count), NOT a certified rating",
        "model": "sandbox-diffusive-screening-v1 (NOT hydrodynamics)",
    }
    if hydrograph is not None:
        out["peak_discharge_m3s"] = hydrograph["peak_discharge_m3s"]
        out["time_to_peak_min"] = hydrograph["time_to_peak_min"]
        out["hydrograph_volume_m3"] = hydrograph["total_volume_m3"]
    return out
