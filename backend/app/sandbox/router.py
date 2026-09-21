"""
DamSafe Twin Sandbox — REST API.

All simulation here is synchronous numpy compute (no DB, no Celery):
fast enough for interactive use at sim grids ≤128. Transport is
raster payloads (base64 float32 grids), never per-cell calls.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from app.auth.service import require_role
from app.sandbox import assets as assets_mod
from app.sandbox import ensemble as ens
from app.sandbox import explainer as expl
from app.sandbox import scenarios as agent
from app.sandbox.dam_registry import get_dam
from app.sandbox.engine import run_scenario
from app.sandbox.impact_run import build_estimate
from app.sandbox.response import hydrograph_payload as _hydrograph_payload
from app.sandbox.response import summarize as _summarize
from app.sandbox.schemas import (
    AssetExposure,
    EnsembleRequest,
    GenerateRequest,
    RunRequest,
)
from app.sandbox.terrain import available_dams, load_elevation, resolve_dam
from app.sandbox.terrain_providers import TerrainUnavailableError

router = APIRouter()
DEMO_DIR = Path(__file__).resolve().parent / "demo_cache"


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=np.float32).tobytes()).decode()


def _dam_meta(dam_id: str) -> dict:
    """Known dam → full record with terrain, acquiring DEM on demand.

    Unknown ids → 404. Terrain acquisition failure → 503 with the
    provider stage trail (never a bare 'No terrain' when generation
    was possible, never silent mock data when it was not).
    """
    if get_dam(dam_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown dam id '{dam_id}'")
    try:
        return resolve_dam(dam_id)
    except TerrainUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _resolve_level(scenario, elev: np.ndarray):
    if scenario.reservoir_level_m and scenario.reservoir_level_m > 0:
        return scenario
    # Documented default: terrain mean elevation as still-water reference.
    scenario = scenario.model_copy(update={"reservoir_level_m": float(elev.mean())})
    return scenario


@router.get("/dams", dependencies=[Depends(require_role("viewer"))])
async def list_sim_dams():
    """Dams with a terrain domain available for simulation."""
    return {"total": len(available_dams()), "dams": available_dams()}


@router.post("/scenarios/generate", dependencies=[Depends(require_role("viewer"))])
async def generate_scenarios(body: GenerateRequest):
    """AI scenario agent: parameter sets only — best/likely/worst + ensemble."""
    if get_dam(body.dam_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown dam id '{body.dam_id}'")
    triplet = agent.generate_triplet(body.dam_id, seed=body.seed)
    ensemble_params = agent.generate_ensemble(body.dam_id, count=body.ensemble_count, seed=body.seed)
    return {
        "dam_id": body.dam_id,
        "best": triplet["best"].model_dump(),
        "likely": triplet["likely"].model_dump(),
        "worst": triplet["worst"].model_dump(),
        "ensemble": [s.model_dump() for s in ensemble_params],
        "method": triplet["method"],
        "note": triplet["note"],
    }


def _run_one(dam_id: str, scenario, grid_size: int, lat: float, lon: float):
    elev, cell_m, bbox = load_elevation(dam_id, grid_size)
    scenario = _resolve_level(scenario, elev)
    result = run_scenario(elev, cell_m, scenario)
    hydrograph = _hydrograph_payload(scenario)
    raw_assets, provenance = assets_mod.load_assets(dam_id, lat, lon)
    exposed = [ens.asset_exposure(a, result.arrival_min, result.maxdepth_m, cell_m, bbox)
               for a in raw_assets]
    exposed.sort(key=lambda a: (-a["priority"], a.get("arrival_min") or 1e9))
    return result, bbox, cell_m, exposed, provenance, scenario, hydrograph, elev


@router.post("/run", dependencies=[Depends(require_role("analyst"))])
async def run_simulation(body: RunRequest):
    """Run one scenario. Returns summary + hydrograph + frames + assets."""
    meta = _dam_meta(body.dam_id)
    scenario = body.scenario.model_copy(update={"seed": body.seed if body.seed is not None else body.scenario.seed})
    result, bbox, cell_m, exposed, provenance, scenario, hydrograph, elev = _run_one(
        body.dam_id, scenario, body.grid_size, meta["lat"], meta["lon"])
    summary = _summarize(result, exposed, hydrograph)
    explanation = expl.explain_run(summary, exposed, scenario.label)
    # Transparent impact estimate (hazard → exposure → vulnerability → impact →
    # loss → avoided loss) computed from THIS run — no extra API round trip.
    estimate = build_estimate(
        elevation=elev, cell_m=cell_m, bbox=bbox,
        depth_m=result.maxdepth_m, arrival_min=result.arrival_min,
        assets=exposed, provenance=provenance,
        dam={"name": meta["name"], "lat": meta["lat"], "lon": meta["lon"]},
        scenario=scenario.model_dump(), engine="sandbox-diffusive-screening-v1",
    )
    return {
        "mode": "REAL COMPUTED SIMULATION",
        "dam_id": body.dam_id,
        "dam_name": meta["name"],
        "terrain": meta["terrain"],
        "scenario": scenario.model_dump(),
        "simulation": {
            "status": "completed",
            "solver": "sandbox-diffusive-screening-v1",
            "solver_note": "Terrain-constrained diffusive propagation (Manning-analogue). "
                           "Screening model — NOT hydrodynamics/CFD/HEC-RAS.",
            "duration_min": round(result.sim_minutes, 1),
            "timesteps": len(result.frames or []),
            "grid": body.grid_size,
            "cell_m": round(cell_m, 2),
        },
        "grid": body.grid_size,
        "cell_m": round(cell_m, 2),
        "bbox_wsen": bbox,
        "summary": summary,
        "hydrograph": hydrograph,
        "frames": result.frames or [],
        "assets": exposed,
        "asset_provenance": provenance,
        "impact_estimate": estimate,
        "explanation": explanation,
        "provenance": {
            "dem_source": meta["terrain"].get("source"),
            "dem_dataset": meta["terrain"].get("dataset"),
            "dem_fallback_used": meta["terrain"].get("fallback_used", False),
            "solver_version": "sandbox-diffusive-screening-v1",
        },
        "warnings": [
            "Screening-level model: compare cases, do not treat outputs as predictions.",
            "Operational decisions require calibrated hydrodynamic modeling + surveyed bathymetry.",
        ],
        "grids": {
            "arrival_min_b64": _b64(result.arrival_min),
            "maxdepth_m_b64": _b64(result.maxdepth_m),
        },
    }


@router.post("/ensemble", dependencies=[Depends(require_role("analyst"))])
async def run_ensemble(body: EnsembleRequest):
    """Multi-scenario ensemble: actual runs, aggregated exposure, comparison."""
    meta = _dam_meta(body.dam_id)
    lat, lon = meta["lat"], meta["lon"]
    triplet = agent.generate_triplet(body.dam_id, seed=body.seed)
    ensemble_params = agent.generate_ensemble(body.dam_id, count=body.count, seed=body.seed)

    cases: dict[str, dict] = {}
    for label, sc in [("best", triplet["best"]), ("likely", triplet["likely"]), ("worst", triplet["worst"])]:
        result, bbox, cell_m, exposed, provenance, sc_res, hg, elev_worst = _run_one(
            body.dam_id, sc, body.grid_size, lat, lon)
        cases[label] = {"summary": _summarize(result, exposed, hg), "params": sc_res.model_dump(),
                        "arrival": result.arrival_min, "depth": result.maxdepth_m}
        if label == "worst":
            worst_pack = (bbox, cell_m, exposed, provenance, sc_res, result, elev_worst)

    runs = []
    for sc in ensemble_params:
        result, bbox, cell_m, _, _, sc_res, hg, _elev = _run_one(body.dam_id, sc, body.grid_size, lat, lon)
        runs.append({"label": sc_res.label, "summary": _summarize(result, [], hg),
                     "params": sc_res.model_dump(),
                     "arrival": result.arrival_min, "depth": result.maxdepth_m})

    agg = ens.aggregate_cells([r["arrival"] for r in runs], [r["depth"] for r in runs])
    raw_assets, provenance = assets_mod.load_assets(body.dam_id, lat, lon)
    assets_out = []
    for a in raw_assets:
        per_run = []
        for r in runs:
            e = ens.asset_exposure(a, r["arrival"], r["depth"], cell_m, bbox)
            per_run.append(e)
        wet_runs = [e for e in per_run if e["arrival_min"] is not None]
        pct = round(len(wet_runs) / max(len(runs), 1) * 100.0, 1)
        rep = max(per_run, key=lambda e: e["max_depth_m"]) if per_run else None
        entry = dict(a)
        arrs = [e["arrival_min"] for e in wet_runs]
        entry.update({
            "arrival_min": round(min(arrs), 1) if arrs else None,
            "median_arrival_min": round(float(np.median(arrs)), 1) if arrs else None,
            "worst_arrival_min": round(max(arrs), 1) if arrs else None,
            "max_depth_m": round(max([e["max_depth_m"] for e in per_run]) if per_run else 0.0, 2),
            "severity": max([e["severity"] for e in per_run]) if per_run else 0,
            "exposure_pct": pct,
            "exposure_class": ens.classify_exposure(pct),
            "priority": (max([e["severity"] for e in per_run]) if per_run else 0) * 10
                        + (5 if pct >= 70 else 0),
        })
        assets_out.append(entry)
        _ = rep
    assets_out.sort(key=lambda a: (-a["priority"], a.get("arrival_min") or 1e9))

    comparison = {label: {"flooded_area_km2": c["summary"]["flooded_area_km2"],
                          "assets_critical": c["summary"]["assets_critical"],
                          "earliest_asset_arrival_min": None,
                          "max_depth_anywhere_m": c["summary"]["max_depth_anywhere_m"],
                          "peak_discharge_m3s": c["summary"].get("peak_discharge_m3s"),
                          "severity_band": c["summary"].get("severity_band")}
                  for label, c in cases.items()}
    drivers = expl.compare_driver_deltas(cases)
    for label, c in cases.items():
        c["summary"]["drivers"] = drivers
    explanation = expl.explain_run(
        {**cases["worst"]["summary"], "drivers": drivers}, assets_out, "worst (ensemble)")

    # Impact estimate on the worst case, with the ensemble's per-cell scenario
    # frequency as the inundation likelihood (real spread, never invented).
    w_bbox, w_cell, w_assets, w_prov, w_scenario, w_result, w_elev = worst_pack
    # `w_assets` are the worst-case exposures already sampled by _run_one.
    estimate = build_estimate(
        elevation=w_elev, cell_m=w_cell, bbox=w_bbox,
        depth_m=w_result.maxdepth_m, arrival_min=w_result.arrival_min,
        assets=w_assets, provenance=w_prov,
        dam={"name": meta["name"], "lat": lat, "lon": lon},
        scenario=w_scenario.model_dump(), engine="sandbox-diffusive-screening-v1",
        exposure_pct=agg["exposure_pct"], ensemble_runs=len(runs),
    )

    payload_runs = [{"label": r["label"], "summary": r["summary"]} for r in runs]
    return {
        "mode": "REAL COMPUTED SIMULATION",
        "dam_id": body.dam_id,
        "dam_name": meta["name"],
        "terrain": meta["terrain"],
        "count": len(runs),
        "grid": body.grid_size,
        "cell_m": round(cell_m, 2),
        "bbox_wsen": bbox,
        "comparison": comparison,
        "runs": payload_runs,
        "aggregate_grids": {
            "exposure_pct_b64": _b64(agg["exposure_pct"]),
            "earliest_min_b64": _b64(agg["earliest_min"]),
            "median_min_b64": _b64(agg["median_min"]),
            "worst_min_b64": _b64(agg["worst_min"]),
            "maxdepth_m_b64": _b64(agg["maxdepth_m"]),
        },
        "assets": assets_out,
        "asset_provenance": provenance,
        "impact_estimate": estimate,
        "exposure_classes": "High-confidence ≥70% / Probable 40–70% / Low-probability <40% of scenarios (scenario-based indicators, NOT statistical guarantees)",
        "explanation": explanation,
    }


@router.get("/assets/{dam_id}", dependencies=[Depends(require_role("viewer"))])
async def get_assets(dam_id: str):
    meta = _dam_meta(dam_id)
    raw, provenance = assets_mod.load_assets(dam_id, meta["lat"], meta["lon"])
    return {"dam_id": dam_id, "provenance": provenance, "total": len(raw), "assets": raw}


@router.get("/demo/tehri", dependencies=[Depends(require_role("viewer"))])
async def get_demo():
    """Deterministic demo bundle (precomputed, cached — no live APIs)."""
    path = DEMO_DIR / "tehri_demo.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Demo bundle not built. Run backend/app/sandbox/make_demo.py.")
    bundle = json.loads(path.read_text(encoding="utf-8"))
    bundle["mode"] = "OFFLINE DEMO (precomputed — not a live calculation)"
    return bundle
