"""
DamSafe Twin — Simulation Orchestration Service

Manages solver job lifecycle: enqueue → track → complete/fail.
Celery tasks run the actual solver work.
"""

from datetime import datetime
from typing import Optional, List
from uuid import UUID

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SimRun, Scenario


async def create_sim_run(db: AsyncSession, scenario_id: UUID) -> SimRun:
    """Create a new simulation run in queued status."""
    sim_run = SimRun(
        scenario_id=scenario_id,
        job_status="queued",
        result_layers={},
    )
    db.add(sim_run)
    await db.flush()
    await db.refresh(sim_run)
    return sim_run


async def get_sim_run(db: AsyncSession, sim_run_id: UUID) -> Optional[SimRun]:
    """Get a simulation run by ID."""
    result = await db.execute(select(SimRun).where(SimRun.id == sim_run_id))
    return result.scalar_one_or_none()


async def list_sim_runs(
    db: AsyncSession,
    scenario_id: Optional[UUID] = None,
    job_status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[List[SimRun], int]:
    """List simulation runs with optional filters."""
    query = select(SimRun)
    count_query = select(func.count(SimRun.id))

    if scenario_id:
        query = query.where(SimRun.scenario_id == scenario_id)
        count_query = count_query.where(SimRun.scenario_id == scenario_id)
    if job_status:
        query = query.where(SimRun.job_status == job_status)
        count_query = count_query.where(SimRun.job_status == job_status)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    query = query.order_by(SimRun.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    runs = list(result.scalars().all())

    return runs, total


async def update_sim_run_status(
    db: AsyncSession,
    sim_run_id: UUID,
    status: str,
    result_layers: Optional[dict] = None,
    mass_balance_error: Optional[float] = None,
    within_tolerance: Optional[bool] = None,
    error_message: Optional[str] = None,
) -> SimRun:
    """Update simulation run status (called by Celery worker)."""
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise ValueError(f"SimRun {sim_run_id} not found")

    sim_run.job_status = status
    if status == "running" and not sim_run.started_at:
        sim_run.started_at = datetime.utcnow()
    if status in ("done", "failed"):
        sim_run.finished_at = datetime.utcnow()
    if result_layers is not None:
        sim_run.result_layers = result_layers
    if mass_balance_error is not None:
        sim_run.mass_balance_error = mass_balance_error
    if within_tolerance is not None:
        sim_run.within_tolerance = within_tolerance
    if error_message is not None:
        sim_run.error_message = error_message

    await db.flush()
    await db.refresh(sim_run)
    return sim_run


async def get_latest_completed_run(db: AsyncSession, scenario_id: UUID) -> Optional[SimRun]:
    """Get the most recent completed simulation run for a scenario."""
    result = await db.execute(
        select(SimRun)
        .where(SimRun.scenario_id == scenario_id, SimRun.job_status == "done")
        .order_by(SimRun.finished_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()
