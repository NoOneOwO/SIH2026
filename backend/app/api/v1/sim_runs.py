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

    from app.worker import CLASSIC_SOLVERS
    if scenario.solver not in CLASSIC_SOLVERS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Solver '{scenario.solver}' cannot run on the classic queue. "
                f"Supported here: {sorted(CLASSIC_SOLVERS)}. "
                "LISFLOOD-FP runs via POST /api/v1/lisflood/run."
            ),
        )

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


@router.delete("/{sim_run_id}")
async def cancel_sim_run(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a queued simulation run before the worker picks it up.

    Only ``queued`` runs can be cancelled (the worker refuses to start any
    run that is no longer queued, so this is race-safe). Running jobs must
    finish; failed/done jobs are history.
    """
    sim_run = await service.get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")
    if sim_run.job_status != "queued":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot cancel a '{sim_run.job_status}' run; only 'queued' runs are cancellable",
        )
    await service.update_sim_run_status(
        db, sim_run_id, "failed", error_message="Cancelled by user before dispatch",
    )
    return {"id": str(sim_run_id), "job_status": "failed", "message": "Run cancelled"}


@router.get("")
async def list_sim_runs(
    scenario_id: Optional[UUID] = Query(None),
    job_status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List simulation runs (DB classic path + sandbox ledger) with filters.

    The interactive sandbox/impact engine is stateless, so its completed runs
    live in the run ledger (backend/data/run_ledger.json) instead of the
    ``sim_runs`` table. Both sources are merged here so Alert Console and
    Report Generator show every completed run without the user ever needing
    to hunt for a UUID — rows carry dam/case labels for readable pickers.
    """
    runs, total = await service.list_sim_runs(db, scenario_id, job_status, limit, offset)
    merged = [
        {
            "id": str(r.id),
            "run_kind": "classic",
            "dam_id": None,
            "dam_name": None,
            "case": None,
            "scenario_id": str(r.scenario_id),
            "job_status": r.job_status,
            "mass_balance_error": r.mass_balance_error,
            "within_tolerance": r.within_tolerance,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        }
        for r in runs
    ]

    # Sandbox ledger: only 'done' runs are shown, matching the classic filter.
    ledger_count = 0
    if job_status in (None, "done"):
        from app.runledger import list_runs as ledger_list

        for row in ledger_list(dam_id=None, limit=limit):
            if scenario_id is not None:
                continue  # ledger rows have no scenario_id; classic filter wins
            merged.append({
                "id": row["id"],
                "run_kind": row.get("run_kind", "sandbox"),
                "dam_id": row.get("dam_id"),
                "dam_name": row.get("dam_name"),
                "case": row.get("case"),
                "scenario_id": None,
                "job_status": "done",
                "mass_balance_error": None,
                "within_tolerance": None,
                "created_at": row.get("created_at"),
                "finished_at": row.get("created_at"),
                "summary": row.get("summary", {}),
                "grids_present": row.get("grids_present", False),
            })
            ledger_count += 1
    merged.sort(key=lambda x: x.get("finished_at") or x.get("created_at") or "", reverse=True)
    return {
        "total": total + ledger_count,
        "limit": limit,
        "offset": offset,
        "sim_runs": merged,
    }
