"""
DamSafe Twin — sandbox run ledger.

The interactive sandbox/impact path is stateless (no DB rows), which used to
leave the Alert Console and Report Generator staring at an empty "completed
runs" list and users hunting for a UUID that did not exist. This ledger gives
every COMPLETED screening run a persistent id and a queryable record.

WHAT QUALIFIES AS A COMPLETED RUN
---------------------------------
A sandbox/impact engine run whose payload reports real computed output
(`mode` starting with "REAL COMPUTED") — i.e. the backend actually executed the
screening engine on real DEM terrain for that dam and returned grids + summary.
Loading the offline demo bundle or a failed run is NOT recorded. Classic-path
Celery runs keep their own DB records (SimRun) and are unaffected.

Storage: JSON file under backend/data/run_ledger.json (same pattern as the
other local stores). IDs are full UUID4s so alerts/reports can reference them.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

LEDGER_PATH = Path(__file__).resolve().parents[1] / "data" / "run_ledger.json"

MAX_RECORDS = 500  # keep the file bounded; oldest records drop off


def _read() -> list[dict]:
    if not LEDGER_PATH.exists():
        return []
    try:
        return json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def _write(rows: list[dict]) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")


def record_run(
    *,
    dam_id: str,
    dam_name: str,
    case: str,
    mode: str,
    summary: dict,
    engine: str,
    scenario: dict | None = None,
    grids_present: bool = False,
    run_kind: str = "sandbox",
) -> dict | None:
    """Persist a completed run; returns its ledger row (or None if not real).

    Only "REAL COMPUTED" runs are recorded — the offline demo bundle is never
    entered into the ledger, so it can never masquerade as a completed run.
    """
    if not str(mode or "").startswith("REAL COMPUTED"):
        return None
    row = {
        "id": str(uuid.uuid4()),
        "run_kind": run_kind,                      # sandbox | impact
        "dam_id": dam_id,
        "dam_name": dam_name,
        "case": case,
        "mode": mode,
        "engine": engine,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "created_ts": time.time(),
        "grids_present": bool(grids_present),
        "scenario": scenario or {},
        "summary": summary or {},
    }
    rows = _read()
    rows.append(row)
    _write(rows[-MAX_RECORDS:])
    return row


def list_runs(dam_id: str | None = None, run_kind: str | None = None, limit: int = 100) -> list[dict]:
    """Newest-first ledger rows, optionally filtered by dam or kind."""
    rows = _read()
    if dam_id:
        rows = [r for r in rows if r.get("dam_id") == dam_id]
    if run_kind:
        rows = [r for r in rows if r.get("run_kind") == run_kind]
    rows.sort(key=lambda r: r.get("created_ts", 0), reverse=True)
    return rows[: max(1, min(limit, MAX_RECORDS))]


def get_run(run_id: str) -> dict | None:
    for r in _read():
        if r.get("id") == run_id:
            return r
    return None
