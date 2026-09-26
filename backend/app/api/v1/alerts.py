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
    # The run id comes from the URL path; the UI does not send it in the body.
    # Kept optional (not removed) so older callers that passed it still work.
    sim_run_id: Optional[str] = None
    scenario_id: Optional[UUID] = None  # required for classic runs; ledger runs have none
    content: Optional[str] = None  # If None, auto-generate recommended content
    language: str = "en"
    severity: str = "warning"


# ------------------------------------------------------------------ ledger runs
# The interactive sandbox/impact engine is stateless; its completed runs live in
# the run ledger (see app.runledger). Alerts for those runs are stored beside
# the other local stores — the DB alert flow (classic runs) is untouched.
import json as _json
import time as _time
import uuid as _uuid
from pathlib import Path as _Path

_FILE_ALERTS_PATH = _Path(__file__).resolve().parent.parent.parent.parent / "data" / "alert_drafts.json"


def _read_file_alerts() -> list[dict]:
    try:
        return _json.loads(_FILE_ALERTS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def _write_file_alerts(items: list[dict]) -> None:
    _FILE_ALERTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _FILE_ALERTS_PATH.write_text(_json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def _ledger_alert_content(run: dict, language: str, severity: str) -> str:
    """Deterministic alert text from the ledger run's own numbers (en/hi).

    Never invented: every figure comes from the recorded run summary; the
    wording states clearly that values are modelled screening estimates.
    """
    s = run.get("summary") or {}
    dam = run.get("dam_name", run.get("dam_id", "dam"))
    case = run.get("case", "likely")
    sev_word = {"watch": "WATCH", "warning": "WARNING", "emergency": "EMERGENCY"}.get(severity, "WARNING")

    # Ledger rows come in two shapes: sandbox /run stores the sim summary
    # (max_depth_anywhere_m, severity_band, assets_*), the impact path stores
    # impact-estimate totals (peak_depth_m, overall_risk, settlements_*).
    # Handle both — every figure below is read from the run itself.
    band = s.get("overall_risk") or s.get("severity_band")
    peak = s.get("peak_depth_m")
    if peak is None:
        peak = s.get("max_depth_anywhere_m")
    earliest = s.get("earliest_arrival_min")
    if earliest is None:
        earliest = s.get("earliest_asset_arrival_min")
    pop = s.get("population_exposed") or {}

    def _middle() -> str:
        has_settlements = "settlements_inundated" in s
        if has_settlements:
            part = (
                f"{s.get('settlements_inundated', 0)} settlement(s) inundated, "
                f"{s.get('settlements_at_risk', 0)} more at risk. "
            )
            if pop.get("low") is not None:
                part += f"Population potentially exposed: {pop.get('low')}–{pop.get('high')}. "
        else:
            part = (
                f"{s.get('assets_critical', 0)} of {s.get('assets_evaluated', 0)} mapped assets "
                "fall in the modelled high-impact zone. "
            )
        if earliest is not None:
            part += f"Earliest modelled arrival: T+{earliest} min. "
        return part

    if language == "hi":
        return (
            f"[{sev_word}] {dam} — मॉडलित बाढ़ परिदृश्य ({case} केस)।\n"
            f"स्क्रीनिंग मॉडल अनुसार: प्रभावित क्षेत्र {s.get('flooded_area_km2', '—')} वर्ग किमी, "
            f"अधिकतम गहराई {peak if peak is not None else '—'} मी। "
            + _middle() +
            "ये मॉडलित अनुमान हैं, पूर्वानुमान नहीं — स्थानीय सत्यापन आवश्यक। "
            f"स्रोत: रन {str(run.get('id', ''))[:8]}।"
        )
    return (
        f"[{sev_word}] {dam} — modelled flood scenario ({case} case).\n"
        f"Screening-model estimate: inundated area {s.get('flooded_area_km2', '—')} km², "
        f"peak water depth {peak if peak is not None else '—'} m. "
        + _middle() +
        "Figures are modelled screening estimates, not forecasts — verify on the ground. "
        f"Source: run {str(run.get('id', ''))[:8]}."
    )


@router.post("/{sim_run_id}/draft", status_code=201)
async def draft_alert(
    sim_run_id: str,
    data: AlertDraftRequest,
    user: CurrentUser = Depends(require_role("operator")),
    db: AsyncSession = Depends(get_db),
):
    """Generate a recommended alert draft. Content auto-generated if not provided.

    Accepts BOTH classic DB run ids and sandbox run-ledger ids: a ledger id
    creates a file-backed draft generated from the run's recorded summary, so
    the user never needs to know where a run id came from.
    """
    # Ledger path first (sandbox/impact runs have no DB row).
    from app.runledger import get_run as ledger_get

    run = ledger_get(str(sim_run_id))
    if run is not None:
        content = data.content or _ledger_alert_content(run, data.language, data.severity)
        alert = {
            "id": _uuid.uuid4().hex[:12],
            "sim_run_id": str(sim_run_id),
            "scenario_id": None,
            "content": content,
            "language": data.language,
            "severity": data.severity,
            "approved_by": None,
            "dispatched_at": None,
            "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
            "store": "ledger",
            "dam_id": run.get("dam_id"),
            "dam_name": run.get("dam_name"),
        }
        items = _read_file_alerts()
        items.append(alert)
        _write_file_alerts(items)
        return {
            "id": alert["id"],
            "content": alert["content"],
            "language": alert["language"],
            "severity": alert["severity"],
            "status": "draft",
            "approved_by": None,
            "message": "Alert draft created from the sandbox run. Requires human approval before dispatch.",
        }

    # Classic DB path (unchanged).
    try:
        run_uuid = UUID(str(sim_run_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="Simulation run not found")
    from app.simulation.service import get_sim_run
    sim_run = await get_sim_run(db, run_uuid)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")
    if data.scenario_id is None:
        data.scenario_id = sim_run.scenario_id

    content = data.content
    if not content:
        content = await service.generate_recommended_alert_content(
            db, run_uuid, data.language
        )

    alert = await service.create_alert_draft(
        db, run_uuid, data.scenario_id, content, data.language, data.severity
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
    alert_id: str,
    user: CurrentUser = Depends(get_approver),
    db: AsyncSession = Depends(get_db),
):
    """
    Human authorization gate — approve an alert for dispatch.
    Requires Approver role. approved_by is set non-null.
    Ledger (file-store) alerts follow the same gate: approval records the user.
    """
    # Ledger/file-store path first.
    items = _read_file_alerts()
    idx = next((i for i, a in enumerate(items) if a.get("id") == str(alert_id)), None)
    if idx is not None:
        if items[idx].get("approved_by"):
            raise HTTPException(status_code=422, detail="Alert already approved")
        if items[idx].get("dispatched_at"):
            raise HTTPException(status_code=422, detail="Alert already dispatched")
        items[idx]["approved_by"] = user.name
        items[idx]["approved_by_id"] = user.id
        items[idx]["approved_at"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
        _write_file_alerts(items)
        return {
            "id": items[idx]["id"],
            "status": "approved",
            "approved_by": items[idx]["approved_by"],
            "message": "Alert approved for dispatch. authorised_by: " + user.name,
        }
    try:
        alert_uuid = UUID(str(alert_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="Alert not found")
    try:
        alert = await service.approve_alert(db, alert_uuid, user.id)
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
    alert_id: str,
    user: CurrentUser = Depends(require_role("approver")),
    db: AsyncSession = Depends(get_db),
):
    """
    Dispatch an approved alert. BLOCKED if not approved.
    Hard gate mirrored for ledger alerts: no approved_by → refuse.
    """
    items = _read_file_alerts()
    idx = next((i for i, a in enumerate(items) if a.get("id") == str(alert_id)), None)
    if idx is not None:
        if not items[idx].get("approved_by"):
            raise HTTPException(status_code=422, detail="Alert must be approved before dispatch")
        if items[idx].get("dispatched_at"):
            raise HTTPException(status_code=422, detail="Alert already dispatched")
        items[idx]["dispatched_at"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
        _write_file_alerts(items)
        return {
            "id": items[idx]["id"],
            "status": "dispatched",
            "dispatched_at": items[idx]["dispatched_at"],
            "message": "Alert dispatched successfully.",
        }
    try:
        alert_uuid = UUID(str(alert_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="Alert not found")
    try:
        alert = await service.dispatch_alert(db, alert_uuid)
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
    """List all alert drafts (DB classic rows + file-store ledger alerts)."""
    alerts, total = await service.list_alerts(db, sim_run_id, limit, offset)
    out = [
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
    ]
    # Merge file-store (ledger) alerts; sim_run_id filter applies to both.
    ledger_count = 0
    for a in _read_file_alerts():
        if sim_run_id is not None and str(a.get("sim_run_id")) != str(sim_run_id):
            continue
        out.append({
            "id": a.get("id"),
            "sim_run_id": a.get("sim_run_id"),
            "scenario_id": a.get("scenario_id"),
            "content": a.get("content", ""),
            "language": a.get("language", "en"),
            "severity": a.get("severity", "watch"),
            "approved_by": a.get("approved_by"),
            "dispatched_at": a.get("dispatched_at"),
            "created_at": a.get("created_at"),
            "dam_name": a.get("dam_name"),
        })
        ledger_count += 1
    return {"total": total + ledger_count, "alerts": out}
