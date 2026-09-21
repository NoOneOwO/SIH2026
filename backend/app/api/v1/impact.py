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
        return run_case(
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

    priorities = await service.compute_evacuation_priorities(db, sim_run_id)
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

    statuses = await service.compute_road_status(db, sim_run_id, t)

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
    """Get hazard index summary for the simulation run."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    from app.impact.service import compute_hazard_index, classify_hazard
    # In production: reads from precomputed raster
    mock_depth = 2.0
    mock_velocity = 3.0
    hazard = compute_hazard_index(mock_depth, mock_velocity)

    return {
        "sim_run_id": str(sim_run_id),
        "hazard_index": round(hazard, 4),
        "hazard_class": classify_hazard(hazard),
        "max_depth_m": mock_depth,
        "max_velocity_ms": mock_velocity,
        "note": "Mock values for MVP; production uses precomputed COG rasters",
    }


@router.get("/{sim_run_id}/facilities")
async def get_facility_exposure(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List critical facilities and their exposure status."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    facilities = await service.get_critical_facilities(db)
    return {
        "sim_run_id": str(sim_run_id),
        "total_facilities": len(facilities),
        "facilities": facilities,
    }
