"""
DamSafe Twin — Alert Service

Draft → Approve → Dispatch state machine with enforced human authorization gate.
"""

from datetime import datetime
from typing import Optional, List
from uuid import UUID

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AlertDraft, SimRun


async def create_alert_draft(
    db: AsyncSession,
    sim_run_id: UUID,
    scenario_id: UUID,
    content: str,
    language: str = "en",
    severity: str = "warning",
) -> AlertDraft:
    """Create a new alert draft (requires human approval before dispatch)."""
    alert = AlertDraft(
        sim_run_id=sim_run_id,
        scenario_id=scenario_id,
        content=content,
        language=language,
        severity=severity,
        approved_by=None,
        dispatched_at=None,
    )
    db.add(alert)
    await db.flush()
    await db.refresh(alert)
    return alert


async def get_alert(db: AsyncSession, alert_id: UUID) -> Optional[AlertDraft]:
    """Get an alert draft by ID."""
    result = await db.execute(select(AlertDraft).where(AlertDraft.id == alert_id))
    return result.scalar_one_or_none()


async def approve_alert(db: AsyncSession, alert_id: UUID, approver_id: UUID) -> AlertDraft:
    """Human authorization gate — approve an alert for dispatch."""
    alert = await get_alert(db, alert_id)
    if not alert:
        raise ValueError("Alert not found")
    if alert.approved_by is not None:
        raise ValueError("Alert has already been approved")
    alert.approved_by = approver_id
    await db.flush()
    await db.refresh(alert)
    return alert


async def dispatch_alert(db: AsyncSession, alert_id: UUID) -> AlertDraft:
    """
    Dispatch an approved alert. BLOCKED if not approved.
    Enforced by DB CHECK constraint: dispatched_at IS NULL OR approved_by IS NOT NULL
    """
    alert = await get_alert(db, alert_id)
    if not alert:
        raise ValueError("Alert not found")
    if alert.approved_by is None:
        raise ValueError(
            "Cannot dispatch alert without human approval. "
            "This is a hard gate — alert.approved_by must be non-null."
        )
    alert.dispatched_at = datetime.utcnow()
    await db.flush()
    await db.refresh(alert)
    return alert


async def list_alerts(
    db: AsyncSession,
    sim_run_id: Optional[UUID] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[List[AlertDraft], int]:
    """List alert drafts with optional filter."""
    query = select(AlertDraft)
    count_query = select(func.count(AlertDraft.id))

    if sim_run_id:
        query = query.where(AlertDraft.sim_run_id == sim_run_id)
        count_query = count_query.where(AlertDraft.sim_run_id == sim_run_id)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    query = query.order_by(AlertDraft.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    alerts = list(result.scalars().all())

    return alerts, total


async def generate_recommended_alert_content(
    db: AsyncSession, sim_run_id: UUID, language: str = "en"
) -> str:
    """
    Generate recommended alert content from simulation results.
    Uses template-based generation with scenario data.
    """
    from app.impact.service import compute_evacuation_priorities
    priorities = await compute_evacuation_priorities(db, sim_run_id)

    top_villages = priorities[:5]

    if language == "hi":
        header = "⚠️ बांध टूटने की चेतावनी — तत्काल कार्रवाई आवश्यक"
        body_lines = [
            f"प्रभावित गाँव ({len(priorities)} कुल):",
        ]
        for v in top_villages:
            body_lines.append(
                f"  • {v['village_name']} (जनसंख्या: {v['population']}) — "
                f"आगमन समय: {v['arrival_time_min']} मिनट"
            )
        footer = "तत्काल निकासी की व्यवस्था करें। सुरक्षित स्थानों की ओर जाएं।"
    else:
        header = "⚠️ DAM BREAK WARNING — IMMEDIATE ACTION REQUIRED"
        body_lines = [
            f"Affected villages ({len(priorities)} total):",
        ]
        for v in top_villages:
            body_lines.append(
                f"  • {v['village_name']} (Pop: {v['population']}) — "
                f"Arrival: {v['arrival_time_min']} min"
            )
        footer = "Evacuate immediately. Move to designated safe zones."

    return f"{header}\n\n" + "\n".join(body_lines) + f"\n\n{footer}"
