"""DamSafe Twin — bridge between the simulation engines and the impact model.

One orchestration point so the sandbox routes, the ensemble route and the
dedicated impact endpoint all feed the estimator the same inputs in the same
way. The estimator itself (`app.impact.estimation`) stays pure: numpy grids in,
JSON out, no engine or network dependency.

Honesty contract: nothing here invents a number. Every value handed to the
estimator is either engine output, a DEM sample, a real OSM tag, or an
arithmetic consequence of those.
"""

from __future__ import annotations

import numpy as np

from app.impact import estimation as est
from app.sandbox import assets as assets_mod
from app.sandbox import ensemble as ens
from app.sandbox import scenarios as agent
from app.sandbox.engine import run_scenario
from app.sandbox.terrain import load_elevation, resolve_dam

# OSM place classes that describe a settlement (vs. a facility).
SETTLEMENT_KINDS = {"city", "town", "village", "hamlet", "suburb", "neighbourhood", "village"}


def settlements_from_assets(assets: list[dict]) -> list[dict]:
    """Real mapped settlements, in OSM node order (never synthesized here)."""
    out = []
    for a in assets:
        kind = str(a.get("kind") or "").lower()
        if kind in SETTLEMENT_KINDS and a.get("lat") is not None and a.get("lon") is not None:
            out.append(a)
    return out


def build_estimate(
    *,
    elevation: np.ndarray,
    cell_m: float,
    bbox: list,
    depth_m: np.ndarray,
    arrival_min: np.ndarray,
    assets: list[dict],
    provenance: str,
    scenario: dict,
    engine: str,
    dam: dict | None = None,
    speed_ms: np.ndarray | None = None,
    exposure_pct: np.ndarray | None = None,
    ensemble_runs: int = 0,
) -> dict:
    """Run the HAZARD→…→AVOIDED-LOSS chain over one engine result."""
    return est.estimate_impact(
        depth_m=depth_m,
        arrival_min=arrival_min,
        bbox=bbox,
        cell_m=cell_m,
        dam=dam or {"name": scenario.get("dam_id", "dam")},
        settlements=settlements_from_assets(assets),
        assets=assets,
        engine=engine,
        assets_provenance=provenance,
        scenario=scenario,
        elevation_m=elevation,
        speed_ms=speed_ms,
        exposure_pct=exposure_pct,
        ensemble_runs=ensemble_runs,
    )


def _resolve_meta(dam_id: str) -> dict:
    from app.sandbox.dam_registry import get_dam

    if get_dam(dam_id) is None:
        raise FileNotFoundError(f"Unknown dam id '{dam_id}'")
    return resolve_dam(dam_id)


def run_case(
    dam_id: str,
    *,
    case: str = "likely",
    grid_size: int = 96,
    ensemble_count: int = 10,
    seed: int = 7,
) -> dict:
    """Generate → simulate → estimate for one scenario case.

    `case` is one of best | likely | worst (the parameter-agent presets). The
    ensemble gives the estimator a *real* scenario-frequency likelihood instead
    of a fabricated probability.
    """
    if case not in ("best", "likely", "worst"):
        raise ValueError("case must be one of: best, likely, worst")

    meta = _resolve_meta(dam_id)
    lat, lon = meta["lat"], meta["lon"]

    elevation, cell_m, bbox = load_elevation(dam_id, grid_size)
    scenario = agent.generate_triplet(dam_id, seed=seed)[case]
    if not scenario.reservoir_level_m or scenario.reservoir_level_m <= 0:
        scenario = scenario.model_copy(update={"reservoir_level_m": float(elevation.mean())})
    result = run_scenario(elevation, cell_m, scenario)

    assets, provenance = assets_mod.load_assets(dam_id, lat, lon)
    exposed = [ens.asset_exposure(a, result.arrival_min, result.maxdepth_m, cell_m, bbox) for a in assets]
    exposed.sort(key=lambda a: (-a["priority"], a.get("arrival_min") or 1e9))

    # Scenario ensemble on the SAME grid so the per-cell exposure frequency
    # lines up with the depth grid the estimate is built on.
    agg = None
    runs = 0
    if ensemble_count >= 2:
        params = agent.generate_ensemble(dam_id, count=min(ensemble_count, 24), seed=seed)
        arrivals, depths = [], []
        for p in params:
            sc = p if (p.reservoir_level_m and p.reservoir_level_m > 0) else p.model_copy(
                update={"reservoir_level_m": float(elevation.mean())})
            r = run_scenario(elevation, cell_m, sc)
            arrivals.append(r.arrival_min)
            depths.append(r.maxdepth_m)
        agg = ens.aggregate_cells(arrivals, depths)
        runs = len(params)

    estimate = build_estimate(
        elevation=elevation,
        cell_m=cell_m,
        bbox=bbox,
        depth_m=result.maxdepth_m,
        arrival_min=result.arrival_min,
        assets=exposed,
        provenance=provenance,
        dam={"name": meta["name"], "lat": lat, "lon": lon},
        scenario=scenario.model_dump(),
        engine="sandbox-diffusive-screening-v1",
        exposure_pct=None if agg is None else agg["exposure_pct"],
        ensemble_runs=runs,
    )
    return {
        "mode": "REAL COMPUTED SIMULATION (screening model) — impact figures are modelled estimates",
        "dam_id": dam_id,
        "dam_name": meta["name"],
        "terrain": meta.get("terrain", {}),
        "case": case,
        "grid_size": grid_size,
        "cell_m": round(float(cell_m), 2),
        "bbox_wsen": bbox,
        "estimate": estimate,
        "ensemble": None if agg is None else {
            "runs": runs,
            "note": "Per-cell share of scenarios that inundate each cell — a scenario frequency, not a statistical probability.",
        },
        "asset_provenance": provenance,
    }
