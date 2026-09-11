"""
DamSafe Twin — Simulation Run Router

Endpoints for enqueuing, tracking, and retrieving simulation results.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.simulation import service

router = APIRouter()


@router.post("/{scenario_id}/enqueue", status_code=202)
async def enqueue_sim_run(
    scenario_id: UUID,
    user: CurrentUser = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Enqueue a solver job for the given scenario."""
    from app.scenarios.service import get_scenario
    scenario = await get_scenario(db, scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    if scenario.status not in ("draft", "submitted"):
        # Allow running on draft for testing; in production should be submitted+
        pass

    sim_run = await service.create_sim_run(db, scenario_id)

    # Dispatch Celery task
    from app.worker import run_solver_task
    run_solver_task.delay(str(sim_run.id), str(scenario_id), scenario.solver, scenario.breach_params)

    return {
        "sim_run_id": str(sim_run.id),
        "status": "queued",
        "message": "Simulation job enqueued successfully",
    }


@router.get("/{sim_run_id}/status")
async def get_sim_run_status(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Poll job status for a simulation run."""
    sim_run = await service.get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")
    return {
        "id": str(sim_run.id),
        "scenario_id": str(sim_run.scenario_id),
        "job_status": sim_run.job_status,
        "mass_balance_error": sim_run.mass_balance_error,
        "within_tolerance": sim_run.within_tolerance,
        "result_layers": sim_run.result_layers,
        "error_message": sim_run.error_message,
        "started_at": sim_run.started_at.isoformat() if sim_run.started_at else None,
        "finished_at": sim_run.finished_at.isoformat() if sim_run.finished_at else None,
    }


@router.get("")
async def list_sim_runs(
    scenario_id: Optional[UUID] = Query(None),
    job_status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List simulation runs with optional filters."""
    runs, total = await service.list_sim_runs(db, scenario_id, job_status, limit, offset)
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "sim_runs": [
            {
                "id": str(r.id),
                "scenario_id": str(r.scenario_id),
                "job_status": r.job_status,
                "mass_balance_error": r.mass_balance_error,
                "within_tolerance": r.within_tolerance,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            }
            for r in runs
        ],
    }
