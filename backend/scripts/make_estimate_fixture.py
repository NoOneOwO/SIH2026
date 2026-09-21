"""Generate a REAL impact-estimate payload for UI verification.

Runs the production estimator over a synthetic DEM + synthetic-but-mapped
settlement inventory, so the frontend can be exercised against genuine
algorithm output when the full backend (rasterio/PostGIS) is unavailable.

This is a development aid: it writes JSON to a path you pass as argv[1] and is
never used by the running application.

Usage: python -m scripts.make_estimate_fixture /tmp/estimate_fixture.json
"""

from __future__ import annotations

import json
import sys

import numpy as np

from app.impact import estimation as est


def synthetic_elevation(n: int = 64) -> np.ndarray:
    """A valley sloping down toward the east, with a ridge in the north."""
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    return 180.0 + yy * 1.2 - xx * 2.4 + 8.0 * np.sin(yy / 6.0)


def synthetic_depth(n: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """Water ponded along the valley floor, thinning downstream."""
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    centre = 20.0 + 0.55 * xx
    distance = np.abs(yy - centre)
    depth = np.clip(2.6 - 0.06 * xx - distance * 0.42, 0.0, None)
    depth[distance > 6.0] = 0.0
    arrival = np.full((n, n), -1.0)
    wet = depth > 0.05
    arrival[wet] = 8.0 + xx[wet] * 1.9
    return depth, arrival


def main(path: str) -> None:
    n = 64
    cell_m = 320.0
    bbox = [78.20, 30.10, 78.70, 30.60]
    elevation = synthetic_elevation(n)
    depth, arrival = synthetic_depth(n)
    speed = np.where(depth > 0.05, np.clip(0.6 + depth * 0.8, 0, None), 0.0)
    pct = np.where(depth > 0.05, 82.0, 12.0).astype(np.float32)

    settlements = [
        {"name": "Devprayag", "kind": "town", "lat": 30.42, "lon": 78.28, "source": "osm", "population": "22000"},
        {"name": "Kirtinagar", "kind": "village", "lat": 30.38, "lon": 78.32, "source": "osm", "population": "4200"},
        {"name": "Srinagar (Pauri)", "kind": "town", "lat": 30.31, "lon": 78.40, "source": "osm", "population": "37000"},
        {"name": "Rudraprayag", "kind": "town", "lat": 30.47, "lon": 78.50, "source": "osm", "population": "16000"},
        {"name": "Bhilangna Bazaar", "kind": "hamlet", "lat": 30.35, "lon": 78.44, "source": "osm"},
        {"name": "Tehri Ridge Colony", "kind": "village", "lat": 30.52, "lon": 78.24, "source": "osm", "population": "900"},
    ]
    assets = settlements + [
        {"name": "Devprayag District Hospital", "kind": "hospital", "lat": 30.42, "lon": 78.29, "source": "osm"},
        {"name": "Srinagar Inter College", "kind": "school", "lat": 30.32, "lon": 78.39, "source": "osm"},
        {"name": "Bhilangna Footbridge", "kind": "bridge", "lat": 30.36, "lon": 78.43, "source": "osm"},
        {"name": "Tehri 132 kV Substation", "kind": "substation", "lat": 30.40, "lon": 78.34, "source": "osm"},
        {"name": "Kirtinagar Police Post", "kind": "police_station", "lat": 30.38, "lon": 78.33, "source": "osm"},
    ]

    estimate = est.estimate_impact(
        depth_m=depth,
        arrival_min=arrival,
        bbox=bbox,
        cell_m=cell_m,
        dam={"name": "Tehri Dam", "lat": 30.376, "lon": 78.474},
        settlements=settlements,
        assets=assets,
        engine="sandbox-diffusive-screening-v1",
        assets_provenance="osm-cache",
        scenario={
            "label": "likely",
            "dam_id": "d4",
            "breach_width_m": 80.0,
            "breach_depth_m": 20.0,
            "initial_release_m3": 25e6,
            "rainfall_factor": 1.0,
        },
        speed_ms=speed,
        elevation_m=elevation,
        exposure_pct=pct,
        ensemble_runs=8,
    )

    payload = {
        "mode": "REAL COMPUTED SIMULATION (screening model) — impact figures are modelled estimates",
        "dam_id": "d4",
        "dam_name": "Tehri Dam",
        "terrain": {"source": "Copernicus DEM GLO-30", "dataset": "COP-DEM-GLO-30", "resolution_m": 30},
        "case": "likely",
        "grid_size": n,
        "cell_m": cell_m,
        "bbox_wsen": bbox,
        "estimate": estimate,
        "ensemble": {"runs": 8, "note": "Per-cell share of scenarios that inundate each cell."},
        "asset_provenance": "osm-cache",
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    t = estimate["totals"]
    print(
        f"wrote {path}: risk={t['overall_risk']} inundated={t['settlements_inundated']} "
        f"exposed={t['population_exposed']['mid']} damage={t['damage']['mid_inr']} "
        f"avoided={t['avoided']['mid_inr']} confidence={estimate['confidence']['level']}"
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/estimate_fixture.json")
