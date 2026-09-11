"""
DamSafe Twin — Alerts Router

Endpoints for alert lifecycle: draft → approve → dispatch.
Human authorization is a hard gate enforced at both app and DB level.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role, get_approver
from app.database import get_db
from app.alerts import service

router = APIRouter()


class AlertDraftRequest(BaseModel):
    sim_run_id: UUID
    scenario_id: UUID
    content: Optional[str] = None  # If None, auto-generate recommended content
    language: str = "en"
    severity: str = "warning"


@router.post("/{sim_run_id}/draft", status_code=201)
async def draft_alert(
    sim_run_id: UUID,
    data: AlertDraftRequest,
    user: CurrentUser = Depends(require_role("operator")),
    db: AsyncSession = Depends(get_db),
):
    """Generate a recommended alert draft. Content auto-generated if not provided."""
    from app.simulation.service import get_sim_run
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    content = data.content
    if not content:
        content = await service.generate_recommended_alert_content(
            db, sim_run_id, data.language
        )

    alert = await service.create_alert_draft(
        db, sim_run_id, data.scenario_id, content, data.language, data.severity
    )
    return {
        "id": str(alert.id),
        "content": alert.content,
        "language": alert.language,
        "severity": alert.severity,
        "status": "draft",
        "approved_by": None,
        "message": "Alert draft created. Requires human approval before dispatch.",
    }


@router.post("/{alert_id}/approve")
async def approve_alert(
    alert_id: UUID,
    user: CurrentUser = Depends(get_approver),
    db: AsyncSession = Depends(get_db),
):
    """
    Human authorization gate — approve an alert for dispatch.
    Requires Approver role. approved_by is set non-null.
    """
    try:
        alert = await service.approve_alert(db, alert_id, user.id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "id": str(alert.id),
        "status": "approved",
        "approved_by": str(user.id),
        "message": "Alert approved for dispatch. authorised_by: " + user.name,
    }


@router.post("/{alert_id}/dispatch")
async def dispatch_alert(
    alert_id: UUID,
    user: CurrentUser = Depends(require_role("approver")),
    db: AsyncSession = Depends(get_db),
):
    """
    Dispatch an approved alert. BLOCKED if not approved.
    Hard gate: dispatched_at IS NULL OR approved_by IS NOT NULL
    """
    try:
        alert = await service.dispatch_alert(db, alert_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "id": str(alert.id),
        "status": "dispatched",
        "dispatched_at": alert.dispatched_at.isoformat() if alert.dispatched_at else None,
        "message": "Alert dispatched successfully.",
    }


@router.get("/list")
async def list_alerts(
    sim_run_id: Optional[UUID] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List all alert drafts."""
    alerts, total = await service.list_alerts(db, sim_run_id, limit, offset)
    return {
        "total": total,
        "alerts": [
            {
                "id": str(a.id),
                "sim_run_id": str(a.sim_run_id),
                "scenario_id": str(a.scenario_id),
                "content": a.content[:200] + "..." if len(a.content or "") > 200 else a.content,
                "language": a.language,
                "severity": a.severity,
                "approved_by": str(a.approved_by) if a.approved_by else None,
                "dispatched_at": a.dispatched_at.isoformat() if a.dispatched_at else None,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in alerts
        ],
    }
