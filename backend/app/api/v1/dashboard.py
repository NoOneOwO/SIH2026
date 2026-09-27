"""
DamSafe Twin — Dashboard Router

Aggregated, honest dashboard data:

  GET /dashboard/stats — chart-ready statistics built ONLY from recorded
  platform activity (run ledger + curated register + file stores). When a
  store is empty the returned series is simply short — no invented values.

  GET /dashboard/news  — recent real-world dam/flood news for India, fetched
  server-side from keyless public feeds (GDACS cyclones+earthquakes near dam
  states, GDELT news index) with a 10-minute cache and honest failure
  ({"articles": [], "note": …}) when a feed is unreachable.
"""

import json
import time
from collections import Counter
from pathlib import Path
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends

from app.auth.service import CurrentUser, require_role

router = APIRouter()

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


def _read_store(name: str) -> list:
    p = BACKEND_DIR / "data" / name
    if not p.exists():
        return []
    try:
        rows = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [r for r in rows if isinstance(r, dict)]


# ── GET /dashboard/stats ──────────────────────────────────────────────────────

@router.get("/stats", dependencies=[Depends(require_role("viewer"))])
def dashboard_stats():
    """Chart series from real records only (ledger + curated register)."""
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from app.runledger import list_runs as ledger_list

    runs = ledger_list(limit=500)
    now = time.time()
    day = 86400.0

    def _ts(r: dict) -> float:
        v = r.get("created_ts")
        return v if isinstance(v, (int, float)) else 0.0

    # 1. Simulations per day, last 14 days (ledger).
    per_day = Counter(int((now - _ts(r)) // day) for r in runs if _ts(r) > 0)
    sim_series = [
        {"day": f"D-{13 - i}", "runs": per_day.get(13 - i, 0)}
        for i in range(14)
    ]

    # 2. Runs per dam (ledger).
    by_dam = Counter((r.get("dam_name") or r.get("dam_id") or "Unknown") for r in runs)
    dam_series = [
        {"dam": k, "runs": v} for k, v in by_dam.most_common(6)
    ]

    # 3. Severity mix of the recorded runs (ledger summary bands).
    band = Counter()
    for r in runs:
        s = r.get("summary") or {}
        v = s.get("overall_risk") or s.get("severity_band")
        if v:
            band[str(v)] += 1
    severity_series = [{"band": k, "count": v} for k, v in band.most_common()]

    # 4. Register composition (curated dam registry shipped with the backend).
    from app.sandbox.dam_registry import all_dams, terrain_ready

    all_registered = all_dams()
    type_counter = Counter(d.get("type", "other") for d in all_registered)
    register_series = [
        {"type": k.replace("_", " "), "count": v} for k, v in type_counter.most_common()
    ]
    terrain_count = sum(1 for d in all_registered if terrain_ready(d.get("id", "")))

    # 5. Alert pipeline status (file store).
    alerts = _read_store("alert_drafts.json")
    alert_series = [
        {"status": "dispatched", "count": sum(1 for a in alerts if a.get("dispatched_at"))},
        {"status": "approved", "count": sum(
            1 for a in alerts if a.get("approved_by") and not a.get("dispatched_at"))},
        {"status": "draft", "count": sum(
            1 for a in alerts if not a.get("approved_by") and not a.get("dispatched_at"))},
    ]

    return {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "totals": {
            "recorded_runs": len(runs),
            "terrain_sites": terrain_count,
            "register_dams": len(all_registered),
            "alerts": len(alerts),
        },
        "series": {
            "sims_per_day": sim_series,
            "runs_per_dam": dam_series,
            "severity_mix": severity_series,
            "register_types": register_series,
            "alert_pipeline": alert_series,
        },
    }


# ── GET /dashboard/news ───────────────────────────────────────────────────────

_NEWS_CACHE: dict = {"at": 0.0, "payload": None}
_NEWS_TTL = 600.0  # 10 minutes


def _fetch_json(url: str, timeout: float = 8.0):
    req = Request(url, headers={"User-Agent": "AquaShield3D-Demo/1.0 (dashboard feed)"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


@router.get("/news", dependencies=[Depends(require_role("viewer"))])
def dashboard_news():
    """Recent real-world dam/flood news near India's major dam states.

    Server-side fetch (no CORS pain), 10-minute cache, honest failure:
    an empty list plus a note — never invented headlines.
    """
    now = time.time()
    if _NEWS_CACHE["payload"] is not None and now - _NEWS_CACHE["at"] < _NEWS_TTL:
        return _NEWS_CACHE["payload"]

    articles: list[dict] = []
    sources_used: list[str] = []

    # GDACS — UN/EU Global Disaster Alert and Coordination System; keyless.
    try:
        days_back = 14
        from_date = time.strftime("%Y-%m-%d", time.gmtime(now - days_back * 86400))
        gd = _fetch_json(f"https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?fromDate={from_date}")
        for ev in (gd or [])[:40]:
            title = str(ev.get("eventtype", "")).title()
            if not title:
                continue
            articles.append({
                "title": f"{title} alert — {ev.get('eventname', 'event')}",
                "source": "GDACS (UN/EU)",
                "date": str(ev.get("fromdate", ""))[:10],
                "url": ev.get("url", {}).get("report") if isinstance(ev.get("url"), dict) else None,
                "severity": ev.get("alertlevel", ""),
                "lat": ev.get("latitude"),
                "lon": ev.get("longitude"),
            })
        if articles:
            sources_used.append("GDACS")
    except Exception:
        pass

    # GDELT DOC 2.0 — keyless global news index; dam/flood reporting in India.
    try:
        gdelt = _fetch_json(
            "https://api.gdeltproject.org/api/v2/doc/doc?query=(dam%20OR%20reservoir%20OR%20barrage)%20"
            "(flood%20OR%20safety%20OR%20discharge%20OR%20%22heavy%20rain%22)%20sourcecountry:in"
            "&mode=artlist&maxrecords=25&timespan=7d&format=json&sort=datedesc"
        )
        for a in (gdelt.get("articles") or [])[:25]:
            articles.append({
                "title": a.get("title", ""),
                "source": a.get("domain", ""),
                "date": str(a.get("seendate", ""))[:8],
                "url": a.get("url"),
                "severity": "",
                "lat": None,
                "lon": None,
            })
        if gdelt.get("articles"):
            sources_used.append("GDELT")
    except Exception:
        pass

    # Dedup by title, newest first, cap 12.
    seen: set[str] = set()
    uniq: list[dict] = []
    for a in sorted(
        articles,
        key=lambda x: str(x.get("date", "")),
        reverse=True,
    ):
        t = (a.get("title") or "").strip().lower()
        if not t or t in seen:
            continue
        seen.add(t)
        uniq.append(a)
    uniq = uniq[:12]

    payload = {
        "articles": uniq,
        "sources": sources_used,
        "note": (
            f"Live public disaster/news feeds ({', '.join(sources_used)}). "
            "External reporting — not platform model output."
            if uniq
            else "News feeds unreachable right now — showing no items rather than invented ones."
        ),
        "fetched_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _NEWS_CACHE["at"] = now
    _NEWS_CACHE["payload"] = payload
    return payload
