"""
Generate app/demo_seed.py — an honest snapshot of THIS deployment's real
stores (run ledger, alert drafts, local accounts), embedded as code so an
ephemeral host (Render free tier wipes the disk on every deploy) still
boots with genuine demo data.

Every number embedded here was really computed by the sandbox/impact engine
during this session; nothing is invented. Re-run after meaningful local
sessions to refresh the snapshot:

    python scripts/make_demo_seed.py
"""

import json
import pprint
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
DATA = BACKEND / "data"
OUT = BACKEND / "app" / "demo_seed.py"

LEDGER = DATA / "run_ledger.json"
ALERTS = DATA / "alert_drafts.json"
USERS = DATA / "users.json"


def load(p: Path, cap: int) -> list:
    if not p.exists():
        return []
    try:
        rows = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    rows = [r for r in rows if isinstance(r, dict)]
    rows.sort(key=lambda r: r.get("created_ts", r.get("created_at", 0)) if isinstance(r.get("created_ts"), (int, float)) else 0, reverse=True)
    return rows[:cap]


def fmt(v) -> str:
    # pformat → valid PYTHON literals (json.dumps would emit true/false/null)
    return pprint.pformat(v, width=100, sort_dicts=False)


ledger = load(LEDGER, 12)
alerts = load(ALERTS, 20)
users = [u for u in load(USERS, 50) if u.get("email") != "admin@damsafe.local"]  # seed admin is created by code

body = f'''"""
Demo seed snapshot — REAL recorded data, embedded for ephemeral deploys.

Render's free tier has no persistent disk, so the run ledger / alert store
built up during a session vanish on every redeploy, leaving the Alert
Console and Report Generator empty in the live demo. This module embeds the
genuine records from the development session (every figure was really
computed by the sandbox/impact engine and every alert really went through
the human approve → dispatch gates) and re-applies them at startup — but
ONLY into empty stores, so live usage is never overwritten.

Refresh the snapshot after a meaningful local session:

    python scripts/make_demo_seed.py
"""

RUN_LEDGER_ROWS = {fmt(ledger)}

ALERT_DRAFT_ROWS = {fmt(alerts)}

USER_ROWS = {fmt(users)}


def seed_demo_stores() -> dict:
    """Populate ONLY-EMPTY stores from the embedded snapshot (idempotent)."""
    import json
    from pathlib import Path

    data_dir = Path(__file__).resolve().parent.parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    applied = {{}}

    stores = (
        (data_dir / "run_ledger.json", RUN_LEDGER_ROWS, "runs"),
        (data_dir / "alert_drafts.json", ALERT_DRAFT_ROWS, "alerts"),
        (data_dir / "users.json", USER_ROWS, "users"),
    )
    for path, rows, label in stores:
        if path.exists() and path.read_text(encoding="utf-8").strip():
            applied[label] = "already-populated"
            continue
        if rows:
            path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
            applied[label] = f"seeded-{{len(rows)}}-rows"
        else:
            applied[label] = "snapshot-empty"
    return applied
'''

OUT.write_text(body, encoding="utf-8")
print(f"wrote {OUT} ({len(ledger)} runs, {len(alerts)} alerts, {len(users)} users)")
