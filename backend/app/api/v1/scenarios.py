"""
DamSafe Twin — Scenarios Router

CRUD + lifecycle endpoints for dam-break scenarios.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.scenarios.schemas import ScenarioCreate, ScenarioUpdate, ScenarioResponse, ScenarioListResponse
from app.scenarios import service

router = APIRouter()


@router.post("", response_model=ScenarioResponse, status_code=201)
async def create_scenario(
    data: ScenarioCreate,
    user: CurrentUser = Depends(require_role("operator")),
    db: AsyncSession = Depends(get_db),
):
    """Create a new scenario draft."""
    scenario = await service.create_scenario(db, data)
    return scenario


@router.get("", response_model=ScenarioListResponse)
async def list_scenarios(
    dam_id: Optional[UUID] = Query(None),
    status: Optional[str] = Query(None),
    failure_mode: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List scenarios with optional filters."""
    scenarios, total = await service.list_scenarios(db, dam_id, status, failure_mode, limit, offset)
    return ScenarioListResponse(total=total, limit=limit, offset=offset, scenarios=scenarios)


@router.get("/{scenario_id}", response_model=ScenarioResponse)
async def get_scenario(
    scenario_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get a single scenario by ID."""
    scenario = await service.get_scenario(db, scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return scenario


@router.patch("/{scenario_id}", response_model=ScenarioResponse)
async def update_scenario(
    scenario_id: UUID,
    data: ScenarioUpdate,
    user: CurrentUser = Depends(require_role("operator")),
    db: AsyncSession = Depends(get_db),
):
    """Update a draft scenario. Only allowed when status='draft'."""
    try:
        scenario = await service.update_scenario(db, scenario_id, data)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return scenario


@router.post("/{scenario_id}/submit", response_model=ScenarioResponse)
async def submit_scenario(
    scenario_id: UUID,
    user: CurrentUser = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Submit a scenario for approval (draft → submitted)."""
    try:
        scenario = await service.submit_scenario(db, scenario_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return scenario


@router.post("/{scenario_id}/approve", response_model=ScenarioResponse)
async def approve_scenario(
    scenario_id: UUID,
    user: CurrentUser = Depends(require_role("approver")),
    db: AsyncSession = Depends(get_db),
):
    """Approve a submitted scenario (submitted → approved)."""
    try:
        scenario = await service.approve_scenario(db, scenario_id, user.id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return scenario


@router.post("/{scenario_id}/lock", response_model=ScenarioResponse)
async def lock_scenario(
    scenario_id: UUID,
    user: CurrentUser = Depends(require_role("approver")),
    db: AsyncSession = Depends(get_db),
):
    """Lock an approved scenario (approved → locked)."""
    try:
        scenario = await service.lock_scenario(db, scenario_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return scenario


@router.get("/{scenario_id}/results")
async def get_scenario_results(
    scenario_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Fetch precomputed result layers for an approved/locked scenario."""
    from app.models import Scenario, SimRun
    from sqlalchemy import select

    scenario = await service.get_scenario(db, scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    if scenario.status not in ("approved", "locked"):
        raise HTTPException(status_code=422, detail="Results only available for approved or locked scenarios")

    # Get the latest completed sim_run
    result = await db.execute(
        select(SimRun)
        .where(SimRun.scenario_id == scenario_id, SimRun.job_status == "done")
        .order_by(SimRun.finished_at.desc())
        .limit(1)
    )
    sim_run = result.scalar_one_or_none()
    if not sim_run:
        raise HTTPException(status_code=404, detail="No completed simulation results found")

    return {
        "scenario_id": str(scenario_id),
        "sim_run_id": str(sim_run.id),
        "status": scenario.status,
        "result_layers": sim_run.result_layers,
        "mass_balance_error": sim_run.mass_balance_error,
        "within_tolerance": sim_run.within_tolerance,
    }
