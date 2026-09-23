"""DamSafe Twin — LISFLOOD-FP REST API (real hydraulic jobs).

Mount: /api/v1/lisflood/...
Auth follows the existing role pattern (viewer reads, analyst runs).
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth.service import require_role

from .jobs import _job_dir, cancel_job, read_status, status_with_progress, submit
from .schemas import LisfloodRunRequest

router = APIRouter()


class RunAccepted(BaseModel):
    job_id: str
    status: str = "queued"
    poll: str


@router.post("/run", response_model=RunAccepted, status_code=202)
def run_simulation(body: LisfloodRunRequest, _user=Depends(require_role("analyst"))):
    """Validate scenario, stage terrain + LISFLOOD inputs, launch engine."""
    # Dam posting scope: officials run only their own dam (admins exempt).
    from app.auth.local import require_dam_scope

    if _user.role != "admin" and getattr(_user, "dam_id", None) and _user.dam_id != body.dam_id:
        raise HTTPException(
            status_code=403,
            detail=f"Your posting is {_user.dam_id}; simulations are limited to your dam. "
                   f"Use the AI assistant to ask about {body.dam_id}.",
        )
    try:
        job_id = submit(body)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"job submission failed: {e}")
    return RunAccepted(job_id=job_id, poll=f"/api/v1/lisflood/{job_id}")


@router.get("/{job_id}")
def job_status(job_id: str, _user=Depends(require_role("viewer"))):
    """Status + honest progress (routing % derived from engine .mass Time)."""
    st = status_with_progress(job_id)
    if st is None:
        raise HTTPException(status_code=404, detail=f"unknown job '{job_id}'")
    return st


@router.get("/{job_id}/metadata")
def job_metadata(job_id: str, _user=Depends(require_role("viewer"))):
    """Full staging manifest: DEM identity, CRS, breach, gauges, debug."""
    path = _job_dir(job_id) / "metadata.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"no metadata for job '{job_id}'")
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/{job_id}/result")
def job_result(job_id: str, _user=Depends(require_role("viewer"))):
    """Parsed LISFLOOD outputs: stats, impacts, grids, animation frames.

    Grids are float32 base64, row0 = north. See metadata for CRS/transform.
    """
    path = _job_dir(job_id) / "result.json"
    if not path.exists():
        st = read_status(job_id)
        if st is None:
            raise HTTPException(status_code=404, detail=f"unknown job '{job_id}'")
        if st.get("status") == "failed":
            raise HTTPException(status_code=422, detail=f"SIMULATION FAILED: {st.get('error')}")
        raise HTTPException(status_code=409, detail=f"job not complete (status={st.get('status')})")
    return json.loads(path.read_text(encoding="utf-8"))


@router.delete("/{job_id}")
def cancel_job_endpoint(job_id: str, _user=Depends(require_role("analyst"))):
    """Cancel a queued job before the engine picks it up (running jobs finish)."""
    try:
        return cancel_job(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown job '{job_id}'")
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/{job_id}/logs")
def job_logs(job_id: str, _user=Depends(require_role("viewer"))):
    """Engine stdout/stderr tails for debugging (SIMULATION FAILED triage)."""
    jobdir = _job_dir(job_id)
    if not jobdir.exists():
        raise HTTPException(status_code=404, detail=f"unknown job '{job_id}'")
    out = {}
    for name in ("stdout.log", "stderr.log"):
        p = jobdir / name
        out[name] = p.read_text(encoding="utf-8", errors="replace")[-8000:] if p.exists() else ""
    return out
