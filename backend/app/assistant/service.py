"""DamSafe Twin — assistant service.

Two-tier answering:
1. Real LLM (OpenAI-compatible) when OPENAI_API_KEY is set — grounded with
   the curated dam KB and/or structured simulation results. Low temperature,
   instructed never to invent hydraulic values.
2. Grounded fallback (no key): KB lookup + rules-based explainer. Every number
   cited comes from the KB or a real result file — nothing is hallucinated.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

_KB_PATH = Path(__file__).resolve().parent / "dams_kb.json"
_BRIEFS_PATH = Path(__file__).resolve().parent / "dam_briefs.json"
_KB: dict | None = None
_BRIEFS: dict | None = None


def kb() -> dict:
    global _KB
    if _KB is None:
        _KB = json.loads(_KB_PATH.read_text(encoding="utf-8"))
    return _KB


def briefs() -> dict:
    """Per-dam brief file (one entry per registry dam). Callers send only the
    relevant slice as LLM context — never the whole file."""
    global _BRIEFS
    if _BRIEFS is None:
        _BRIEFS = json.loads(_BRIEFS_PATH.read_text(encoding="utf-8"))
    return _BRIEFS


def brief_for(dam_id: str) -> dict | None:
    for b in briefs().get("briefs", []):
        if b.get("id") == dam_id:
            return b
    return None


def find_dam(query: str, registry: list[dict] | None = None) -> dict | None:
    """Match a dam by id, name fragment, river or state (KB first, then registry)."""
    q = (query or "").strip().lower()
    if not q:
        return None
    for d in kb()["dams"]:
        hay = " ".join([d.get("id", ""), d.get("name", ""), d.get("river", ""), d.get("state", "")]).lower()
        if q == d["id"].lower() or q in d["name"].lower() or (len(q) > 3 and q in hay):
            return {"source": "kb", **d}
    if registry:
        for d in registry:
            hay = " ".join([str(d.get("id", "")), str(d.get("name", "")), str(d.get("river", "")), str(d.get("state", ""))]).lower()
            if q == str(d.get("id", "")).lower() or q in str(d.get("name", "")).lower():
                return {"source": "registry", **d}
    return None


def dam_brief(d: dict) -> str:
    lines = [
        f"{d.get('name')} ({d.get('id', '')}) — {d.get('state', '')}, on the {d.get('river', '')} river.",
        f"Type: {d.get('type', '—')}; height {d.get('height_m', '—')} m"
        + (f", length {d.get('length_m', '—')} m" if d.get("length_m") else "")
        + f"; storage ~{d.get('capacity_mcm', '—')} MCM"
        + (f" ({d.get('year', '—')})" if d.get("year") else "")
        + ".",
    ]
    if d.get("power_mw"):
        lines.append(f"Hydropower: ~{d['power_mw']} MW. Owner/operator: {d.get('owner', '—')}.")
    if d.get("purpose"):
        lines.append("Purposes: " + ", ".join(d["purpose"]) + ".")
    for h in (d.get("highlights") or [])[:4]:
        lines.append("• " + h)
    return "\n".join(lines)


# ------------------------------------------------------------------ LLM tier

def _llm_config() -> tuple[str, str, str] | None:
    """(base_url, api_key, model) — Groq first, generic OpenAI-compatible next."""
    if os.environ.get("GROQ_API_KEY"):
        return (
            os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/"),
            os.environ["GROQ_API_KEY"],
            os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"),
        )
    if os.environ.get("OPENAI_API_KEY"):
        return (
            os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
            os.environ["OPENAI_API_KEY"],
            os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        )
    return None


def _llm_available() -> bool:
    return _llm_config() is not None


def _llm_provider() -> str:
    cfg = _llm_config()
    if cfg is None:
        return "none"
    return "groq" if os.environ.get("GROQ_API_KEY") else "openai-compatible"


def llm_chat(system: str, user: str) -> str | None:
    """Call the configured chat endpoint. None on any failure (fallback)."""
    import httpx

    cfg = _llm_config()
    if cfg is None:
        return None
    base, key, model = cfg
    try:
        r = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "temperature": 0.2,
                "max_tokens": 800,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout=45.0,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception:
        return None


SYSTEM_BASE = (
    "You are DamSafe Twin's dam-safety assistant for Indian dam officials. "
    "Answer concisely in plain language. Use ONLY the dam facts and simulation "
    "results provided below — never invent heights, capacities, arrival times, "
    "depths or populations. If a fact is unavailable, say so. Frame everything "
    "as decision support, never as a validated engineering prediction. "
    "End with one line: 'Source: <provided facts / simulation result>'."
)


def answer(message: str, dam: dict | None, registry: list[dict] | None,
           context: str | None = None) -> dict:
    """Answer a chat question with optional dam + live simulation context."""
    """Answer a chat question with optional dam context."""
    msg = message.strip()
    if dam is None:
        # Try to detect a dam mention in the message.
        candidates = [d for d in kb()["dams"]] + (registry or [])
        hit = None
        ml = msg.lower()
        for d in candidates:
            name = str(d.get("name", "")).lower()
            if name and (name in ml or (len(name.split()[0]) > 4 and name.split()[0] in ml)):
                hit = d
                break
        dam = hit

    facts = dam_brief(dam) if dam else "No specific dam selected."
    # Relevant slice of the briefs file for the LLM (never the whole file).
    brief_ctx = ""
    if dam and dam.get("id"):
        b = brief_for(dam["id"])
        if b:
            brief_ctx = "\n\nStructured dam brief (JSON):\n" + json.dumps(b, ensure_ascii=False)
    sim_ctx = ""
    if context and context.strip():
        sim_ctx = ("\n\nACTIVE SIMULATION CONTEXT (measured results, attached by the app — "
                   "treat these numbers as ground truth for this conversation):\n"
                   + context.strip()[:5000])
    if _llm_available():
        reply = llm_chat(
            SYSTEM_BASE
            + "\n\nDam facts:\n" + facts + brief_ctx + sim_ctx
            + "\n\nYou may also draw on your own training knowledge of Indian dams "
            + "for background, but every number you state about THIS dam must come "
            + "from the facts/brief/simulation context above.",
            msg,
        )
        if reply:
            return {"reply": reply, "source": _llm_provider(), "dam_id": (dam or {}).get("id")}
    # Grounded fallback.
    if dam:
        extra = ""
        ml = msg.lower()
        if any(w in ml for w in ("status", "health", "safe", "condition", "risk")):
            extra = (
                "\n\nLive structural status is not available in this prototype — "
                "status here means the curated profile above. For operational status, "
                "consult the dam authority / SDSO instrumentation readings."
            )
        if any(w in ml for w in ("simulate", "run", "flood", "breach", "scenario")):
            extra += (
                "\n\nTo model a breach, open the dam in Incident Console → Run "
                "Sandbox (or Quick Run). Results return real "
                "depth/arrival grids you can animate on the 3D terrain."
            )
        if context and context.strip():
            extra += "\n\nActive simulation context:\n" + context.strip()[:2000]
        return {
            "reply": f"{facts}{extra}\n\nSource: curated dam knowledge base (public references, 2026).",
            "source": "knowledge-base",
            "dam_id": dam.get("id"),
        }
    names = ", ".join(d["name"] for d in kb()["dams"][:10])
    return {
        "reply": (
            "I can brief you on Indian dams (profiled in detail: "
            f"{names}, …) — pick a dam above or name one. I can also explain "
            "simulation results and draft preparedness measures from real outputs.\n\n"
            "Source: curated dam knowledge base."
        ),
        "source": "knowledge-base",
        "dam_id": None,
    }


# ------------------------------------------------------- explainer tier

def _band(max_depth: float) -> str:
    if max_depth < 0.05:
        return "DRY"
    if max_depth < 0.3:
        return "LOW"
    if max_depth < 1.0:
        return "MODERATE"
    if max_depth < 2.5:
        return "HIGH"
    return "EXTREME"


def danger_index(band: str, critical_count: int) -> tuple[int, str]:
    """Single 0–100 danger score from the severity band + critical assets.

    Deterministic and documented: band base (DRY 5 / LOW 20 / MODERATE 45 /
    HIGH 70 / VERY HIGH 80 / EXTREME 90) plus up to 10 for critical assets.
    """
    base = {"DRY": 5, "LOW": 20, "MODERATE": 45, "HIGH": 70,
            "VERY HIGH": 80, "EXTREME": 90, "CRITICAL": 90}.get(band, 45)
    score = min(100, base + min(10, max(0, critical_count) * 2))
    label = "Low" if score < 30 else ("Moderate" if score < 55 else ("High" if score < 75 else "Extreme"))
    return score, label


def explain_simulation(stats: dict, impacts: list[dict], meta: dict, kind: str) -> dict:
    """Turn real result numbers into an explanation + phased action plan.

    Deterministic rules over measured values. An LLM (if configured) only
    rephrases — it never sees a request to invent hydraulics.
    """
    wet = [i for i in impacts if i.get("inundated")]
    wet_sorted = sorted(wet, key=lambda i: (i.get("arrival_min") if i.get("arrival_min") is not None else 1e9))
    maxd = float(stats.get("max_depth_m", 0) or 0)
    area = float(stats.get("inundated_area_km2", 0) or 0)
    cells = int(stats.get("inundated_cells", 0) or 0)
    frames = int(stats.get("frames", 0) or 0)
    band = _band(maxd)

    headline = (
        f"Modelled {kind} breach floods {area:.2f} km² ({cells} cells) with peak depth "
        f"{maxd:.2f} m — severity band {band}."
    )
    bullets = [
        f"Peak depth {maxd:.2f} m and max speed {float(stats.get('max_speed_ms', 0) or 0):.2f} m/s "
        f"are cell maxima over {frames} saved time slices.",
        f"{len(wet)} of {len(impacts)} exposure points inundated."
        + (f" First impact: {wet_sorted[0].get('name')} at ~{wet_sorted[0].get('arrival_min')} min "
           f"({wet_sorted[0].get('max_depth_m')} m)." if wet_sorted and wet_sorted[0].get("arrival_min") is not None else ""),
        "Arrival times come from gauge depth series (first wetting > 0.10 m); "
        "per-point depths prefer the gauge history over all-time grid maxima.",
        f"Mass-balance diagnostics Q/V error: {stats.get('mass_q_error')} / {stats.get('mass_v_error')} "
        "(~1e-9 or smaller indicates a numerically clean run).",
    ]
    crit = [i for i in wet if i.get("status") == "CRITICAL"]
    soon = [i for i in wet_sorted[:3] if i.get("arrival_min") is not None]
    score, danger_label = danger_index(band, len(crit))
    plan = [
        {"phase": "0–30 min — warn & verify",
         "actions": [
             "Raise the EAP notification chain for: " + (", ".join(i.get("name", "?") for i in soon) if soon else "no arrivals inside the domain — extend the domain or duration"),
             "Verify modelled arrivals against gauge/telemetry readings before public alerts.",
             "Hold reservoir at or below the modelled level; prepare controlled releases per the rule curve.",
         ]},
        {"phase": "30–120 min — move people",
         "actions": [
             f"Prioritise evacuation of {len(crit)} CRITICAL location(s)" + (f" ({', '.join(i.get('name', '?') for i in crit[:4])})" if crit else "") + " along the traced valley path.",
             "Close downstream road crossings where modelled depth exceeds 0.3 m; barricade before water arrives, not after.",
             "Pre-position SDRF/NDRF and medical posts at shelters outside the modelled footprint.",
         ]},
        {"phase": "Beyond the event — harden",
         "actions": [
             "Review spillway gate readiness and freeboard against the modelled peak inflow.",
             "Audit embankment toes, drainage and instrumentation where modelled velocity exceeds ~2 m/s.",
             "Re-run with longer duration and wider domain to capture the full recession before monsoon sign-off.",
             "Record all parameters and approvals in the audit trail for the statutory safety review.",
         ]},
    ]
    out = {"headline": headline, "bullets": bullets, "reinforcement_plan": plan, "source": "rules",
           "danger_index": score, "danger_label": danger_label, "severity_band": band}
    if _llm_available():
        polished = llm_chat(
            SYSTEM_BASE + " Rephrase the following simulation summary for a dam official: keep every number identical, add nothing.",
            json.dumps({"headline": headline, "bullets": bullets}, indent=1),
        )
        if polished:
            out["llm_brief"] = polished
            out["source"] = "rules+llm"
    return out


def quick_prompts() -> list[str]:
    return [
        "Tell me everything about Tehri Dam",
        "Compare Bhakra and Sardar Sarovar",
        "Which dams generate the most power?",
        "What does severity band EXTREME mean?",
        "How do I run a breach simulation?",
    ]
