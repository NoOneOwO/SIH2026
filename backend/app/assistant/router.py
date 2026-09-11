"""DamSafe Twin — assistant REST API (chatbot + result explainer)."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth.service import require_role
from app.sandbox.dam_registry import get_dam

from . import service as svc

router = APIRouter()
SIMS_ROOT = Path(__file__).resolve().parent.parent.parent / "sims"


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    dam_id: str | None = Field(None, max_length=32)
    context: str | None = Field(None, max_length=6000,
        description="Active simulation context (summary text) — attached by the UI, never typed by the user")


class ChatResponse(BaseModel):
    reply: str
    source: str
    dam_id: str | None = None


class ExplainRequest(BaseModel):
    kind: str = Field("lisflood", pattern="^(lisflood|sandbox)$")
    job_id: str | None = None
    summary: dict | None = None
    impacts: list[dict] | None = None


def _registry() -> list[dict]:
    try:
        from app.sandbox import dam_registry as reg

        return list(reg.DAMS)
    except Exception:
        return []


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest, _user=Depends(require_role("viewer"))):
    dam = None
    if body.dam_id:
        dam = svc.find_dam(body.dam_id, _registry())
        if dam is None and get_dam(body.dam_id):
            dam = {"source": "registry", **get_dam(body.dam_id)}
        if dam is None:
            raise HTTPException(status_code=404, detail=f"Unknown dam '{body.dam_id}'")
    out = svc.answer(body.message, dam, _registry(), context=body.context)
    return ChatResponse(**out)


@router.get("/dams")
def assistant_dams(_user=Depends(require_role("viewer"))):
    """Dams the assistant can brief in detail + registry fallback list."""
    return {
        "detailed": [
            {"id": d["id"], "name": d["name"], "state": d.get("state"), "river": d.get("river")}
            for d in svc.kb()["dams"]
        ],
        "briefs": len(svc.briefs().get("briefs", [])),
        "count_registry": len(_registry()),
        "prompts": svc.quick_prompts(),
        "llm": svc._llm_available(),
        "provider": svc._llm_provider(),
    }


@router.post("/explain")
def explain(body: ExplainRequest, _user=Depends(require_role("viewer"))):
    """Explain real result numbers + phased preparedness plan. No invented hydraulics."""
    if body.kind == "lisflood":
        if not body.job_id or not body.job_id.replace("_", "").replace("-", "").isalnum():
            raise HTTPException(status_code=422, detail="job_id required")
        rp = SIMS_ROOT / body.job_id / "result.json"
        mp = SIMS_ROOT / body.job_id / "metadata.json"
        if not rp.exists():
            raise HTTPException(status_code=404, detail=f"no result for job '{body.job_id}'")
        result = json.loads(rp.read_text(encoding="utf-8"))
        meta = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {}
        return svc.explain_simulation(result.get("stats", {}), result.get("impacts", []), meta, "LISFLOOD-FP")
    # sandbox: frontend posts the computed summary + impacts
    if not body.summary:
        raise HTTPException(status_code=422, detail="summary required for sandbox explanations")
    stats = {
        "max_depth_m": body.summary.get("max_depth_anywhere_m", 0),
        "inundated_cells": -1,
        "inundated_area_km2": body.summary.get("flooded_area_km2", 0),
        "max_speed_ms": 0,
        "mass_q_error": None,
        "mass_v_error": None,
        "frames": len((body.summary.get("frames") or [])),
    }
    impacts = [
        {"name": a.get("name"), "kind": a.get("kind"), "inundated": (a.get("max_depth_m") or 0) > 0.05,
         "max_depth_m": a.get("max_depth_m", 0), "arrival_min": a.get("arrival_min"),
         "status": "CRITICAL" if (a.get("max_depth_m") or 0) > 1.0 else ("AT RISK" if (a.get("max_depth_m") or 0) > 0.05 else "SAFE"),
         "source": a.get("source", "sandbox")}
        for a in (body.impacts or [])
    ]
    return svc.explain_simulation(stats, impacts, {}, "sandbox screening")
