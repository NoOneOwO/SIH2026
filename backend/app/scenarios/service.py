"""
DamSafe Twin — Scenario Service

Business logic for scenario lifecycle: create → submit → approve → lock.
"""

from datetime import datetime
from typing import Optional, List
from uuid import UUID

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Scenario
from app.scenarios.schemas import ScenarioCreate, ScenarioUpdate


async def create_scenario(db: AsyncSession, data: ScenarioCreate) -> Scenario:
    """Create a new scenario in draft status."""
    scenario = Scenario(
        dam_id=data.dam_id,
        failure_mode=data.failure_mode,
        variant=data.variant,
        breach_params=data.breach_params,
        dem_version_id=data.dem_version_id,
        roughness_map_id=data.roughness_map_id,
        solver=data.solver,
        solver_version=data.solver_version,
        description=data.description,
        status="draft",
    )
    db.add(scenario)
    await db.flush()
    await db.refresh(scenario)
    return scenario


async def get_scenario(db: AsyncSession, scenario_id: UUID) -> Optional[Scenario]:
    """Get a scenario by ID."""
    result = await db.execute(select(Scenario).where(Scenario.id == scenario_id))
    return result.scalar_one_or_none()


async def list_scenarios(
    db: AsyncSession,
    dam_id: Optional[UUID] = None,
    status: Optional[str] = None,
    failure_mode: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[List[Scenario], int]:
    """List scenarios with optional filters. Returns (scenarios, total_count)."""
    query = select(Scenario)
    count_query = select(func.count(Scenario.id))

    if dam_id:
        query = query.where(Scenario.dam_id == dam_id)
        count_query = count_query.where(Scenario.dam_id == dam_id)
    if status:
        query = query.where(Scenario.status == status)
        count_query = count_query.where(Scenario.status == status)
    if failure_mode:
        query = query.where(Scenario.failure_mode == failure_mode)
        count_query = count_query.where(Scenario.failure_mode == failure_mode)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    query = query.order_by(Scenario.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    scenarios = list(result.scalars().all())

    return scenarios, total


async def update_scenario(db: AsyncSession, scenario_id: UUID, data: ScenarioUpdate) -> Optional[Scenario]:
    """Update a draft scenario. Only allowed when status='draft'."""
    scenario = await get_scenario(db, scenario_id)
    if not scenario:
        return None
    if scenario.status != "draft":
        raise ValueError(f"Cannot update scenario in '{scenario.status}' status; only 'draft' is editable")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(scenario, field, value)
    scenario.updated_at = datetime.utcnow()
    await db.flush()
    await db.refresh(scenario)
    return scenario


async def submit_scenario(db: AsyncSession, scenario_id: UUID) -> Scenario:
    """Submit a scenario for approval (draft → submitted)."""
    scenario = await get_scenario(db, scenario_id)
    if not scenario:
        raise ValueError("Scenario not found")
    if scenario.status != "draft":
        raise ValueError(f"Can only submit scenarios in 'draft' status; current: '{scenario.status}'")
    scenario.status = "submitted"
    scenario.updated_at = datetime.utcnow()
    await db.flush()
    await db.refresh(scenario)
    return scenario


async def approve_scenario(db: AsyncSession, scenario_id: UUID, approver_id: UUID) -> Scenario:
    """Approve a scenario (submitted → approved). Enforces DB-level CHECK constraint."""
    scenario = await get_scenario(db, scenario_id)
    if not scenario:
        raise ValueError("Scenario not found")
    if scenario.status != "submitted":
        raise ValueError(f"Can only approve scenarios in 'submitted' status; current: '{scenario.status}'")
    scenario.status = "approved"
    scenario.approved_by = approver_id
    scenario.approved_at = datetime.utcnow()
    scenario.updated_at = datetime.utcnow()
    await db.flush()
    await db.refresh(scenario)
    return scenario


async def lock_scenario(db: AsyncSession, scenario_id: UUID) -> Scenario:
    """Lock an approved scenario (approved → locked, no further changes)."""
    scenario = await get_scenario(db, scenario_id)
    if not scenario:
        raise ValueError("Scenario not found")
    if scenario.status != "approved":
        raise ValueError(f"Can only lock scenarios in 'approved' status; current: '{scenario.status}'")
    scenario.status = "locked"
    scenario.updated_at = datetime.utcnow()
    await db.flush()
    await db.refresh(scenario)
    return scenario
