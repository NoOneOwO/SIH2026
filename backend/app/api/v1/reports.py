"""
DamSafe Twin — Reports Router

One-click EAP / incident summary PDF generation.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
import io

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.reports import service
from app.scenarios.service import get_scenario, list_scenarios
from app.simulation.service import get_latest_completed_run
from app.impact import service as impact_service

router = APIRouter()


# ------------------------------------------------------------------ sandbox-run reports
# The interactive sandbox/impact engine records completed runs in the run ledger
# (app.runledger). This endpoint builds an EAP-style PDF/HTML report for EITHER
# a ledger run or a classic DB run, optionally polishing the officer's note with
# the configured LLM (Groq) — grounded, never inventing numbers.

import json as _rjson
import time as _rtime

from pydantic import BaseModel as _BaseModel, Field as _Field


class RunReportBody(_BaseModel):
    note: str = _Field(default="", max_length=8000, description="Officer's free text to embed (and optionally AI-polish)")
    enhance: bool = _Field(default=False, description="Polish the note with the configured LLM (Groq) — officer facts preserved verbatim")
    title: str = _Field(default="Flood impact & emergency decision-support report", max_length=200)


class AssistNoteBody(_BaseModel):
    dam_id: str | None = _Field(default=None, max_length=32)
    run_id: str | None = _Field(default=None, max_length=64)
    kind: str = _Field(default="SITUATION REPORT", max_length=40)
    title: str = _Field(default="", max_length=200)
    note: str = _Field(..., min_length=1, max_length=8000)


_ASSIST_SYSTEM = (
    "You draft official emergency-management documents for Indian dam officials. "
    "You receive the officer's raw note, the document kind/title and modelled "
    "run facts. Rewrite the officer's note into a clear, structured, professional "
    "document body: situation, requested actions, and closing. Keep EVERY fact "
    "and request the officer wrote — never drop or contradict their specifics. "
    "NEVER invent numbers, places, names or deadlines that were not provided. "
    "Modelled figures must stay labelled as modelled estimates. Under 300 words. "
    "Output ONLY the document body text."
)


def _enhance_note(note: str, title: str, kind: str, facts: str) -> tuple[str, str]:
    """(enhanced_text, source). Falls back to the original note untouched."""
    from app.assistant.service import llm_chat

    try:
        out = llm_chat(
            _ASSIST_SYSTEM,
            f"Document kind: {kind}\nTitle: {title}\n\nModelled run facts:\n{facts}\n\nOfficer's note:\n{note}",
        )
    except Exception:
        out = None
    if out:
        return out.strip(), "groq"
    return note, "not-enhanced (LLM unavailable — officer note kept verbatim)"


def _ledger_report_html(run: dict, title: str, note: str, note_source: str) -> str:
    """Compact EAP-style HTML for a sandbox ledger run."""
    from app.sandbox.dam_registry import get_dam as _get_dam

    rec = _get_dam(run.get("dam_id", "")) or {}
    s = run.get("summary") or {}
    pop = s.get("population_exposed") or {}
    dmg = s.get("damage") or {}
    prio = s.get("priority_counts") or {}

    # Ledger rows come in two shapes: sandbox /run stores the sim summary
    # (max_depth_anywhere_m, severity_band, assets_*), the impact path stores
    # impact-estimate totals (peak_depth_m, overall_risk, settlements_*).
    # Show whichever figures THIS run actually carries.
    band = s.get("overall_risk") or s.get("severity_band")
    peak = s.get("peak_depth_m")
    if peak is None:
        peak = s.get("max_depth_anywhere_m")
    earliest = s.get("earliest_arrival_min")
    if earliest is None:
        earliest = s.get("earliest_asset_arrival_min")
    has_settlements = "settlements_inundated" in s

    def _fmt(v, suffix=""):
        return f"{v}{suffix}" if v is not None else "—"

    scenario = run.get("scenario") or {}
    breach = (
        f"breach width {scenario.get('breach_width_m', '—')} m, depth {scenario.get('breach_depth_m', '—')} m, "
        f"severity {scenario.get('breach_severity', '—')}, release {scenario.get('initial_release_m3', '—')} m³"
        if scenario else "—"
    )
    rows = [
        ("Overall risk band (this scenario)", band if band else "—"),
        ("Modelled inundation area", _fmt(s.get("flooded_area_km2"), " km²")),
        ("Peak modelled water depth", _fmt(peak, " m")),
    ]
    if has_settlements:
        rows.append(("Settlements inundated / at risk", f"{s.get('settlements_inundated', '—')} / {s.get('settlements_at_risk', '—')}"))
        rows.append(("Population potentially exposed (range)", f"{pop.get('low', '—')}–{pop.get('high', '—')}"))
        if dmg:
            rows.append(("Potential damage (range)", f"₹{dmg.get('low_inr', '—')}–₹{dmg.get('high_inr', '—')}"))
        if prio:
            rows.append(("Priority bands (CRITICAL/HIGH/MEDIUM/LOW)", f"{prio.get('CRITICAL', 0)} / {prio.get('HIGH', 0)} / {prio.get('MEDIUM', 0)} / {prio.get('LOW', 0)}"))
    else:
        rows.append(("Mapped assets in high-impact zone", f"{s.get('assets_critical', 0)} of {s.get('assets_evaluated', 0)}"))
        if s.get("peak_discharge_m3s") is not None:
            rows.append(("Modelled peak discharge", _fmt(s.get("peak_discharge_m3s"), " m³/s")))
    rows += [
        ("Earliest modelled arrival", (_fmt(earliest, " min") if earliest is not None else "not resolved")),
        ("Scenario case", run.get("case", "—")),
        ("Scenario parameters", breach),
    ]
    rows_html = "".join(
        f"<tr><td style='padding:6px 10px;border:1px solid #d8dee4;color:#334'>{k}</td>"
        f"<td style='padding:6px 10px;border:1px solid #d8dee4;font-weight:600'>{v}</td></tr>"
        for k, v in rows
    )
    note_html = (
        f"<div style='margin-top:18px;padding:12px;border:1px solid #d8dee4;border-left:4px solid #b45309;background:#fffbeb'>"
        f"<p style='margin:0 0 6px;font-weight:700;color:#334'>Officer's note</p>"
        f"<p style='margin:0;white-space:pre-wrap;color:#334'>{note}</p>"
        f"<p style='margin:8px 0 0;font-size:11px;color:#667'>" 
        + ("Text polished with the configured LLM (officer facts preserved)" if note_source == "groq" else "Officer text, unmodified")
        + "</p></div>"
        if note else ""
    )
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>{title}</title></head>
    <body style="font-family:Georgia,serif;margin:36px;color:#222">
      <h1 style="font-size:20px;margin:0 0 2px">{title}</h1>
      <p style="margin:0 0 14px;color:#667;font-size:12px">AquaShield 3D (DamSafe Twin) • {run.get('created_at','')} • run {str(run.get('id',''))[:8]}</p>
      <h2 style="font-size:15px;border-bottom:2px solid #334;padding-bottom:4px">{rec.get('name', run.get('dam_name', 'Dam'))}</h2>
      <p style="font-size:12px;color:#555;margin:0 0 12px">
        {rec.get('state','—')} • {str(rec.get('type','—')).replace('_',' ')} on {rec.get('river','—')} river •
        height {rec.get('height_m','—')} m • reservoir {rec.get('capacity_mcm','—')} MCM • built {rec.get('year_built','—')}
      </p>
      <table style="border-collapse:collapse;font-size:12.5px;width:100%">{rows_html}</table>
      {note_html}
      <div style="margin-top:18px;padding:10px;background:#f6f8fa;border:1px solid #d8dee4">
        <p style="margin:0;font-size:11px;line-height:1.5;color:#555">
          <b>Modelled estimates — not observations or forecasts.</b> All flood figures come from the
          sandbox-diffusive-screening engine run on a real DEM of this dam site (screening model, NOT
          hydrodynamics/CFD). Population, damage and priority figures are planning-level estimates with
          documented assumptions. Operational decisions require calibrated hydrodynamic modelling and
          field verification.</p>
      </div>
    </body></html>"""


@router.post("/run/{run_id}/report")
async def generate_run_report(
    run_id: str,
    body: RunReportBody,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """EAP-style report for ANY completed run (ledger sandbox run or classic DB run).

    The officer's note is embedded verbatim, optionally polished first by the
    configured LLM (Groq) — the model may restructure prose but must preserve
    every officer fact and never invent figures.
    """
    from app.runledger import get_run as ledger_get

    run = ledger_get(run_id)
    if run is not None:
        facts_lines = [
            f"Dam: {run.get('dam_name')} ({run.get('dam_id')}), case '{run.get('case')}'.",
            f"Modelled results: {run.get('summary')}",
        ]
        note, note_source = (body.note or "", "verbatim")
        if body.enhance and body.note.strip():
            note, note_source = _enhance_note(body.note, body.title, "report", "\n".join(facts_lines))
        html = _ledger_report_html(run, body.title, note, note_source)
    else:
        # Classic DB run (existing pipeline) — note appended, optional polish.
        try:
            run_uuid = UUID(run_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Run not found (neither sandbox ledger nor classic run)")
        from app.simulation.service import get_sim_run

        sim_run = await get_sim_run(db, run_uuid)
        if not sim_run:
            raise HTTPException(status_code=404, detail="Simulation run not found")
        scenario = await get_scenario(db, sim_run.scenario_id)
        if not scenario:
            raise HTTPException(status_code=404, detail="Scenario not found")
        note = body.note or ""
        if body.enhance and note.strip():
            note, _ = _enhance_note(note, body.title, "report", f"solver {scenario.solver} {scenario.solver_version}")
        try:
            priorities = await impact_service.compute_evacuation_priorities(db, run_uuid)
        except impact_service.NoResultGridsError:
            priorities = []
        html = await service.generate_eap_report(
            dam_data={"name": "Dam"},
            scenarios_data=[{
                "failure_mode": scenario.failure_mode,
                "variant": scenario.variant,
                "solver": scenario.solver,
                "solver_version": scenario.solver_version,
                "status": scenario.status,
                "approved_by": None,
                "breach_params": scenario.breach_params,
            }],
            priorities=priorities,
            road_summary={"safe": 0, "restricted": 0, "impassable": 0},
            facilities=[],
            sim_data={"solver": scenario.solver, "solver_version": scenario.solver_version},
        )
        if note:
            html = html.replace(
                "</body>",
                f"<div style='margin-top:18px'><h3>Officer's note</h3><p style='white-space:pre-wrap'>{note}</p></div></body>",
            )

    try:
        pdf_bytes = await service.html_to_pdf(html)
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename=aquashield-report-{run_id[:8]}.pdf"},
        )
    except Exception:
        return StreamingResponse(
            io.BytesIO(html.encode()),
            media_type="text/html",
            headers={"Content-Disposition": f"attachment; filename=aquashield-report-{run_id[:8]}.html"},
        )


@router.post("/assist-note")
def assist_note(
    body: AssistNoteBody,
    user: CurrentUser = Depends(require_role("viewer")),
):
    """Polish the officer's broadcast note with the configured LLM (Groq).

    Grounded: the model receives the dam facts + the recorded run summary (when
    a run id is given) and must preserve every officer fact. Falls back to the
    original text with an honest source label when the LLM is unavailable.
    """
    facts = "No specific dam selected."
    if body.run_id:
        from app.runledger import get_run as ledger_get

        run = ledger_get(body.run_id)
        if run:
            facts = f"Dam: {run.get('dam_name')} ({run.get('dam_id')}), case '{run.get('case')}'. Modelled results: {run.get('summary')}"
    if body.dam_id:
        from app.sandbox.dam_registry import get_dam as _get_dam

        rec = _get_dam(body.dam_id)
        if rec:
            facts = (facts + " " if facts else "") + (
                f"Dam facts: {rec.get('name')}, {rec.get('state')}, {rec.get('type')} on {rec.get('river')} river, "
                f"height {rec.get('height_m')} m, reservoir {rec.get('capacity_mcm')} MCM, built {rec.get('year_built')}."
            )
    enhanced, source = _enhance_note(body.note, body.title, body.kind, facts)
    return {"note": enhanced, "source": source}


@router.get("/{sim_run_id}/pdf")
async def generate_pdf_report(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """One-click EAP/incident PDF report from simulation run data."""
    from app.simulation.service import get_sim_run
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    scenario = await get_scenario(db, sim_run.scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")

    # Gather data
    from app.models import Dam
    from sqlalchemy import select
    dam_result = await db.execute(select(Dam).where(Dam.id == scenario.dam_id))
    dam = dam_result.scalar_one_or_none()

    dam_data = {
        "name": dam.name if dam else "Unknown",
        "dam_type": dam.dam_type if dam else "Unknown",
        "height_m": dam.height_m if dam else "N/A",
        "crest_length_m": dam.crest_length_m if dam else "N/A",
        "reservoir_capacity_mcm": dam.reservoir_capacity_mcm if dam else "N/A",
        "spillway_count": dam.spillway_count if dam else "N/A",
    }

    scenarios_data = [{
        "failure_mode": scenario.failure_mode,
        "variant": scenario.variant,
        "solver": scenario.solver,
        "solver_version": scenario.solver_version,
        "status": scenario.status,
        "approved_by": str(scenario.approved_by) if scenario.approved_by else None,
        "breach_params": scenario.breach_params,
    }]

    try:
        priorities = await impact_service.compute_evacuation_priorities(db, sim_run_id)
        road_statuses = await impact_service.compute_road_status(db, sim_run_id, 0)
        facilities = await impact_service.get_critical_facilities(db, sim_run)
    except impact_service.NoResultGridsError as e:
        raise HTTPException(status_code=422, detail=str(e))
    road_summary = {
        "safe": sum(1 for r in road_statuses if r["status"] == "safe"),
        "restricted": sum(1 for r in road_statuses if r["status"] == "restricted"),
        "impassable": sum(1 for r in road_statuses if r["status"] == "impassable"),
    }

    sim_data = {
        "solver": scenario.solver,
        "solver_version": scenario.solver_version,
        "mass_balance_error": sim_run.mass_balance_error,
    }

    # Generate HTML report
    html = await service.generate_eap_report(
        dam_data=dam_data,
        scenarios_data=scenarios_data,
        priorities=priorities,
        road_summary=road_summary,
        facilities=facilities,
        sim_data=sim_data,
    )

    # Convert to PDF
    try:
        pdf_bytes = await service.html_to_pdf(html)
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename=damsafe-eap-report-{sim_run_id}.pdf"},
        )
    except Exception:
        # Fallback: return HTML if WeasyPrint not available
        return StreamingResponse(
            io.BytesIO(html.encode()),
            media_type="text/html",
            headers={"Content-Disposition": f"attachment; filename=damsafe-eap-report-{sim_run_id}.html"},
        )


@router.get("/{sim_run_id}/html")
async def generate_html_report(
    sim_run_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Generate an HTML report (no PDF conversion)."""
    from app.simulation.service import get_sim_run
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise HTTPException(status_code=404, detail="Simulation run not found")

    scenario = await get_scenario(db, sim_run.scenario_id)
    dam_result = await db.execute(select(Dam).where(Dam.id == scenario.dam_id))
    dam = dam_result.scalar_one_or_none()

    from app.models import Dam
    from sqlalchemy import select as sa_select

    dam_data = {"name": dam.name if dam else "Unknown"} if dam else {}
    try:
        priorities = await impact_service.compute_evacuation_priorities(db, sim_run_id)
        road_statuses = await impact_service.compute_road_status(db, sim_run_id, 0)
        facilities = await impact_service.get_critical_facilities(db, sim_run)
    except impact_service.NoResultGridsError:
        priorities, road_statuses, facilities = [], [], []
    road_summary = {
        "safe": sum(1 for r in road_statuses if r["status"] == "safe"),
        "restricted": sum(1 for r in road_statuses if r["status"] == "restricted"),
        "impassable": sum(1 for r in road_statuses if r["status"] == "impassable"),
    }

    html = await service.generate_eap_report(
        dam_data=dam_data,
        scenarios_data=[{
            "failure_mode": scenario.failure_mode,
            "variant": scenario.variant,
            "solver": scenario.solver,
            "solver_version": scenario.solver_version,
            "status": scenario.status,
            "approved_by": None,
            "breach_params": scenario.breach_params,
        }],
        priorities=priorities,
        road_summary=road_summary,
        facilities=facilities,
        sim_data={"solver": scenario.solver, "solver_version": scenario.solver_version},
    )

    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


# ------------------------------------------------------------------ broadcast
# Official-to-official document broadcast (single-host JSON store; the inbox
# starts empty by design and fills as officials broadcast).

import json as _json
import time as _time
import uuid as _uuid
from pathlib import Path as _Path

from pydantic import BaseModel as _BaseModel, Field as _Field

_BROADCASTS_PATH = _Path(__file__).resolve().parent.parent.parent.parent / "data" / "broadcasts.json"


class BroadcastBody(_BaseModel):
    title: str = _Field(..., min_length=1, max_length=200)
    kind: str = _Field("EAP", max_length=40)
    body: str = _Field(..., min_length=1, max_length=20000)
    dam_id: str | None = _Field(None, max_length=32)


def _read_broadcasts() -> list[dict]:
    try:
        return _json.loads(_BROADCASTS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def _write_broadcasts(items: list[dict]) -> None:
    _BROADCASTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _BROADCASTS_PATH.write_text(_json.dumps(items, indent=2), encoding="utf-8")


@router.post("/broadcast")
def broadcast_document(
    payload: BroadcastBody,
    user: CurrentUser = Depends(require_role("analyst")),
):
    """Broadcast a document to officials + government (stored to the inbox)."""
    items = _read_broadcasts()
    entry = {
        "id": _uuid.uuid4().hex[:12],
        "title": payload.title.strip(),
        "kind": payload.kind.strip() or "EAP",
        "body": payload.body,
        "dam_id": payload.dam_id,
        "from": user.name,
        "from_role": user.role,
        "created_at": _time.time(),
    }
    items.append(entry)
    _write_broadcasts(items)
    return {"status": "broadcast", "id": entry["id"], "recipients": "all officials + government channel"}


@router.get("/inbox")
def broadcast_inbox(user: CurrentUser = Depends(require_role("viewer"))):
    """Documents received from other officials (empty until first broadcast)."""
    items = sorted(_read_broadcasts(), key=lambda e: e.get("created_at", 0), reverse=True)
    return {"total": len(items), "documents": items}
