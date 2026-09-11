"""
Build the deterministic Tehri demo bundle (run once, offline thereafter).

Precomputes: worst-case run (grid 96) + 10-run ensemble (grid 64) +
asset exposure + comparison + explainer text, saved to
app/sandbox/demo_cache/tehri_demo.json. The demo endpoint serves this
file — zero live external calls during the demo.

Usage: python -m app.sandbox.make_demo   (from backend/)
"""

import base64
import json
from pathlib import Path

import numpy as np

from app.sandbox import assets as assets_mod
from app.sandbox import ensemble as ens
from app.sandbox import explainer as expl
from app.sandbox import scenarios as agent
from app.sandbox.engine import run_scenario
from app.sandbox.response import hydrograph_payload, summarize
from app.sandbox.terrain import load_elevation, resolve_dam

DAM_ID = "d4"
OUT = Path(__file__).resolve().parent / "demo_cache" / "tehri_demo.json"


def b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=np.float32).tobytes()).decode()


def main() -> None:
    meta = resolve_dam(DAM_ID)
    lat, lon = meta["lat"], meta["lon"]

    trip = agent.generate_triplet(DAM_ID, seed=7)
    worst = trip["worst"]

    elev96, cell96, bbox = load_elevation(DAM_ID, 96)
    worst = worst.model_copy(update={"reservoir_level_m": float(elev96.mean())})
    res = run_scenario(elev96, cell96, worst)
    hg = hydrograph_payload(worst)

    raw_assets, prov = assets_mod.load_assets(DAM_ID, lat, lon)
    exposed = [ens.asset_exposure(a, res.arrival_min, res.maxdepth_m, cell96, bbox) for a in raw_assets]
    exposed.sort(key=lambda a: (-a["priority"], a.get("arrival_min") or 1e9))

    # Ensemble at grid 64
    ens_params = agent.generate_ensemble(DAM_ID, count=10, seed=7)
    elev64, cell64, _ = load_elevation(DAM_ID, 64)
    runs = []
    for sc in ens_params:
        sc = sc.model_copy(update={"reservoir_level_m": float(elev64.mean())})
        r = run_scenario(elev64, cell64, sc)
        runs.append(r)
    agg = ens.aggregate_cells([r.arrival_min for r in runs], [r.maxdepth_m for r in runs])

    downstream = res.maxdepth_m[~res.source_mask]
    summary = summarize(res, exposed, hg)
    explanation = expl.explain_run(summary, exposed, "worst")

    bundle = {
        "mode": "OFFLINE DEMO (precomputed — not a live calculation)",
        "dam_id": DAM_ID,
        "dam_name": meta["name"],
        "terrain": meta["terrain"],
        "scenario": worst.model_dump(),
        "simulation": {
            "status": "completed",
            "solver": "sandbox-diffusive-screening-v1",
            "duration_min": round(res.sim_minutes, 1),
            "timesteps": len(res.frames or []),
            "grid": 96,
            "cell_m": round(cell96, 2),
        },
        "grid": 96,
        "cell_m": round(cell96, 2),
        "bbox_wsen": bbox,
        "summary": summary,
        "hydrograph": hg,
        "frames": res.frames or [],
        "assets": exposed,
        "asset_provenance": prov,
        "explanation": explanation,
        "grids": {"arrival_min_b64": b64(res.arrival_min), "maxdepth_m_b64": b64(res.maxdepth_m)},
        "ensemble": {
            "count": len(runs),
            "grid": 64,
            "aggregate_grids": {
                "exposure_pct_b64": b64(agg["exposure_pct"]),
                "earliest_min_b64": b64(agg["earliest_min"]),
                "maxdepth_m_b64": b64(agg["maxdepth_m"]),
            },
        },
        "note": "Deterministic cached demo — no live APIs. Regenerate with make_demo.py.",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(bundle), encoding="utf-8")
    print(f"demo bundle: {OUT} ({OUT.stat().st_size / 1024:.0f} KB), "
          f"flooded={summary['flooded_area_km2']} km², assets={len(exposed)} ({prov})")


if __name__ == "__main__":
    main()
