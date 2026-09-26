"""
DamSafe Twin — Impact Analysis Router

Endpoints for evacuation priority, road passability, and hazard data.
"""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.simulation.service import get_sim_run
from app.impact import service
from app.impact.service import NoResultGridsError

router = APIRouter()


class ImpactEstimateRequest(BaseModel):
    """Inputs for the transparent impact estimate (hazard → avoided loss)."""

    dam_id: str = Field(..., description="Terrain site id, e.g. 'd4' or 'd52'")
    case: Literal["best", "likely", "worst"] = Field(
        default="likely", description="Scenario preset from the parameter agent (inputs only)")
    grid_size: int = Field(default=64, ge=32, le=256, description="Screening grid resolution")
    ensemble_count: int = Field(
        default=8, ge=0, le=24,
        description="Scenario runs used for the per-cell exposure frequency (0 = skip)")
    seed: int = 7
    compare_all: bool = Field(
        default=False,
        description="Also run best+likely+worst and return a per-case totals comparison "
                    "(uncertainty spread; the full estimate stays the selected case)")


@router.post("/estimate", dependencies=[Depends(require_role("viewer"))])
async def estimate_impact_endpoint(body: ImpactEstimateRequest):
    """Estimate which settlements are exposed and what the impact could be.

    Runs the screening engine, then the documented impact chain
    (hazard → exposure → vulnerability → impact → economic loss → avoided loss).
    Every figure is returned with its evidence class (observed / derived /
    modelled / assumed) plus a confidence level and the assumption list.
    """
    from app.sandbox.dam_registry import get_dam
    from app.sandbox.impact_run import run_case
    from app.sandbox.terrain_providers import TerrainUnavailableError

    if get_dam(body.dam_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown dam id '{body.dam_id}'")
    try:
        result = run_case(
            body.dam_id,
            case=body.case,
            grid_size=body.grid_size,
            ensemble_count=body.ensemble_count,
            seed=body.seed,
        )
    except TerrainUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    if not body.compare_all:
        return result

    # Uncertainty spread: run the other two presets and compare headline
    # totals. Same deterministic pipeline; nothing here is re-weighted or
    # invented — each column is one full honest run of that case.
    comparison = {}
    for case_key in ("best", "likely", "worst"):
        if case_key == body.case:
            est = result["estimate"]
        else:
            try:
                est = run_case(
                    body.dam_id, case=case_key, grid_size=body.grid_size,
                    ensemble_count=0, seed=body.seed,
                )["estimate"]
            except Exception as e:
                comparison[case_key] = {"error": f"run failed: {e}"}
                continue
        t = est["totals"]
        comparison[case_key] = {
            "overall_risk": t["overall_risk"],
            "flooded_area_km2": t["flooded_area_km2"],
            "peak_depth_m": t["peak_depth_m"],
            "earliest_arrival_min": t["earliest_arrival_min"],
            "settlements_inundated": t["settlements_inundated"],
            "settlements_at_risk": t["settlements_at_risk"],
            "population_exposed_mid": t["population_exposed"]["mid"],
            "damage_mid_inr": t["damage"]["mid_inr"],
            "critical_assets_exposed": t["critical_assets_exposed"],
            "priority_counts": t.get("priority_counts", {}),
        }
    result["scenario_comparison"] = {
        "selected": body.case,
        "cases": comparison,
        "note": "Each column is a full screening run of that preset — a spread of plausible outcomes, not confidence intervals.",
    }
    return result


@router.get("/{sim_run_id}/priority")
async def get_evacuation_priority(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get evacuation priority list ranked by urgency score."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    try:
        priorities = await service.compute_evacuation_priorities(db, sim_run_id)
    except NoResultGridsError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "sim_run_id": str(sim_run_id),
        "total_villages": len(priorities),
        "priorities": priorities,
    }


@router.get("/{sim_run_id}/roads")
async def get_road_passability(
    sim_run_id: UUID,
    t: int = Query(0, description="Time in minutes from breach"),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get road passability status at a given time step."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    try:
        statuses = await service.compute_road_status(db, sim_run_id, t)
    except NoResultGridsError as e:
        raise HTTPException(status_code=422, detail=str(e))

    safe_count = sum(1 for s in statuses if s["status"] == "safe")
    restricted_count = sum(1 for s in statuses if s["status"] == "restricted")
    impassable_count = sum(1 for s in statuses if s["status"] == "impassable")

    return {
        "sim_run_id": str(sim_run_id),
        "time_minutes": t,
        "summary": {
            "total_roads": len(statuses),
            "safe": safe_count,
            "restricted": restricted_count,
            "impassable": impassable_count,
        },
        "roads": statuses,
    }


@router.get("/{sim_run_id}/hazard")
async def get_hazard_summary(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get hazard index summary for the simulation run (from its own grids)."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    try:
        return await service.get_hazard_summary(db, sim_run)
    except NoResultGridsError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/{sim_run_id}/facilities")
async def get_facility_exposure(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List critical facilities and their exposure status (sampled from run grids)."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    try:
        facilities = await service.get_critical_facilities(db, sim_run)
    except NoResultGridsError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "sim_run_id": str(sim_run_id),
        "total_facilities": len(facilities),
        "facilities": facilities,
    }
