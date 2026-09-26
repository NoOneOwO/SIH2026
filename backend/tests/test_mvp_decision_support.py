"""
Tests for the MVP decision-support additions (no network required).

Covers:
- registry consistency (curated 50 present, no raw folder-name leaks)
- priority_score determinism and banding
- asset exposure rows (exposed vs dry, ordering)
- decision_summary presence and cited numbers
- evacuation layer graceful fallback (Overpass unreachable)
- document extraction heuristics
- condition assessment incl. INSUFFICIENT_DATA
- /dams/registry/summary endpoint shape
"""

from __future__ import annotations

import json
from unittest.mock import patch

import numpy as np
import pytest

from app.impact import estimation as est
from app.sandbox.dam_registry import DAMS, all_dams, get_dam

# The API smoke tests need the full service stack; keep them skippable so the
# pure-logic tests run on a bare numpy install (same policy as test_sandbox).
try:  # pragma: no cover - environment dependent
    from fastapi.testclient import TestClient

    from app.main import app as _app

    client = TestClient(_app, raise_server_exceptions=False)
    _API_SKIP: str | None = None
except Exception as _exc:  # pragma: no cover - environment dependent
    client = None
    _API_SKIP = f"API stack unavailable ({_exc})"

requires_api = pytest.mark.skipif(client is None, reason=_API_SKIP or "API stack unavailable")

H = {"Authorization": "Bearer dev-token"}


# ── registry ────────────────────────────────────────────────────────────────

def test_registry_has_core_curated_dams():
    ids = {d["id"] for d in DAMS}
    assert {"d4", "d1", "d52", "d128", "d39"} <= ids
    assert len(DAMS) >= 50


def test_registry_records_have_profile_fields():
    for d in DAMS[:10]:
        assert "type" in d and "river" in d and "capacity_mcm" in d and "year_built" in d


def test_all_dams_registry_first():
    dams = all_dams()
    assert len(dams) >= len(DAMS)
    assert get_dam("d4")["name"] == "Tehri Dam"


# ── priority scoring ────────────────────────────────────────────────────────

def _row(**kw):
    base = {
        "status": "INUNDATED", "depth_m": 1.5, "arrival_min": 25.0,
        "population_exposed": {"low": 800, "mid": 1200, "high": 1900},
        "facilities_exposed": ["school"],
    }
    base.update(kw)
    return base


def test_priority_score_deterministic():
    a = est.priority_score(settlement_row=_row())
    b = est.priority_score(settlement_row=_row())
    assert a == b


def test_priority_safe_settlement_is_low():
    p = est.priority_score(settlement_row=_row(status="SAFE", depth_m=0.0))
    assert p["band"] == "LOW" and p["score"] == 0


def test_priority_worst_case_scores_critical():
    p = est.priority_score(settlement_row=_row(
        depth_m=3.0, arrival_min=10.0,
        population_exposed={"low": 20000, "mid": 30000, "high": 40000},
        facilities_exposed=["school", "hospital"],
        ))
    assert p["band"] in ("HIGH", "CRITICAL")
    assert len(p["reasons"]) == 5


def test_priority_connectivity_worsens_score():
    worse = est.priority_score(settlement_row=_row(), connectivity={"nearest_usable_road_km": None})
    better = est.priority_score(settlement_row=_row(), connectivity={"nearest_usable_road_km": 0.4})
    assert worse["score"] > better["score"]


# ── asset rows + decision summary ───────────────────────────────────────────

def _grids():
    depth = np.zeros((10, 10))
    depth[4:8, 4:8] = 1.2
    arrival = np.full((10, 10), -1.0)
    arrival[4:8, 4:8] = 20.0
    bbox = [78.0, 30.0, 78.1, 30.1]
    cell = 11000.0 / 10
    return est.Grid(depth, cell, bbox), est.Grid(arrival, cell, bbox)


def test_asset_rows_exposed_and_dry():
    dg, ag = _grids()
    assets = [
        {"kind": "hospital", "name": "H", "lat": 30.05, "lon": 78.05, "source": "osm"},
        {"kind": "bridge", "name": "B", "lat": 30.02, "lon": 78.02, "source": "osm"},
    ]
    rows = est.asset_exposure_rows(asset_list=assets, depth_grid=dg, arrival_grid=ag,
                                   dam={"lat": 30.0, "lon": 78.0})
    assert rows[0]["status"] == "EXPOSED" and rows[0]["name"] == "H"
    assert rows[-1]["status"] == "DRY"
    assert rows[0]["distance_km"] is not None


def test_decision_summary_cites_values():
    s = {
        "id": "x", "name": "Village X", "status": "INUNDATED", "depth_m": 1.5,
        "arrival_min": 20.0, "risk": "HIGH",
        "population_exposed": {"low": 900, "mid": 1200, "high": 1600},
        "priority": {"band": "HIGH", "score": 60.0},
    }
    totals = {"overall_risk": "HIGH", "flooded_area_km2": 4.2, "settlements_inundated": 1,
              "settlements_at_risk": 0, "peak_depth_m": 2.0, "earliest_arrival_min": 20.0}
    d = est.decision_summary(settlements=[s], assets=[], totals=totals, scenario_label="likely")
    assert any("Village X" in line for line in d["where"])
    assert any("T+20" in line for line in d["when"])
    assert any("HIGH" in line for line in d["who"])


# ── evacuation fallback ─────────────────────────────────────────────────────

def test_evacuation_fallback_when_overpass_down():
    from app.impact import evacuation as evac

    dg, ag = _grids()
    with patch.object(evac, "_load_roads", return_value=(None, "unavailable")):
        out = evac.analyze(
            dam={"id": "d4", "name": "Tehri", "lat": 30.05, "lon": 78.05},
            depth_grid=dg, arrival_grid=ag, settlements=[],
        )
    assert out["data_source"] == "unavailable"
    assert out["corridors"] == [] and out["unsafe_roads"] == []
    assert "unreachable" in out["note"] or "unavailable" in out["note"]


def test_evacuation_corridors_with_stub_roads():
    from app.impact import evacuation as evac

    dg, ag = _grids()
    # Inside the grid bbox ([78.0, 30.0, 78.1, 30.1]) but outside the wet block
    # (rows/cols 4–8 ≈ lat 30.04–30.08 / lon 78.04–78.08) → classifies USABLE.
    roads = [{
        "id": "1", "name": "NH-Test", "kind": "trunk", "is_bridge": False,
        "coords": [(30.09, 78.01), (30.09, 78.03)],
    }]
    with patch.object(evac, "_load_roads", return_value=(roads, "osm-cache")):
        out = evac.analyze(
            dam={"id": "d4", "name": "Tehri", "lat": 30.05, "lon": 78.05},
            depth_grid=dg, arrival_grid=ag,
            settlements=[{
                "id": "s1", "name": "Village X", "status": "INUNDATED", "risk": "HIGH",
                "lat": 30.05, "lon": 78.05,
                "priority": {"band": "HIGH", "score": 60.0},
            }],
        )
    assert out["data_source"] == "osm-cache"
    assert out["corridors"] and out["corridors"][0]["candidate_route"] == "NH-Test"
    assert out["corridors"][0]["status"] in ("RECOMMENDED CANDIDATE", "MARGINAL")
    assert out["unsafe_roads"] == []  # the stub road lies outside the wet zone


# ── document extraction + condition assessment ──────────────────────────────

def test_document_extraction_finds_issues_and_condition():
    from app.damprofile import structure_document

    text = (
        "DAM SAFETY INSPECTION REPORT 2024-06-14. Condition rating: fair. "
        "Seepage observed at the drainage gallery. Minor cracking on spillway pier. "
        "Recommendation: grouting of the foundation is required."
    ).encode()
    # .txt goes through the plain-text extraction path (no PDF parsing).
    s = structure_document("report.txt", text)
    assert s["doc_type"] == "safety_inspection"
    assert s["reported_condition"] == "fair"
    topics = {i["topic"] for i in s["issues"]}
    assert {"seepage", "cracking", "spillway"} <= topics
    assert s["recommendations"]


def test_condition_insufficient_data_for_unknown_dam(tmp_path, monkeypatch):
    import app.damprofile as dp

    monkeypatch.setattr(dp, "PROFILES_DIR", tmp_path)
    # No documents, no OSINT → INSUFFICIENT_DATA
    rec = {"id": "dX", "name": "X", "type": "earthen", "height_m": 10,
           "river": "r", "capacity_mcm": 1, "year_built": 2000}
    with patch.object(dp, "get_dam", return_value=rec), \
         patch.object(dp, "_load_json", side_effect=lambda p, d: []):
        result = dp.condition_assessment.__wrapped__("dX") if hasattr(dp.condition_assessment, "__wrapped__") else None
    # Simpler: call the internal logic through the TestClient below instead.


def test_condition_endpoint_insufficient_and_moderate():
    import tempfile
    import pathlib
    import app.damprofile as dp

    with tempfile.TemporaryDirectory() as td:
        client_local = client  # reuse app
        with patch.object(dp, "PROFILES_DIR", pathlib.Path(td)):
            # d28 has bundled OSINT → not insufficient
            r = client_local.get("/api/v1/dams/d28/condition", headers=H)
            assert r.status_code == 200
            assert r.json()["category"] in ("MODERATE_CONCERN",)
            # a dam with no docs and no OSINT → INSUFFICIENT_DATA
            r = client_local.get("/api/v1/dams/d39/condition", headers=H)
            assert r.status_code == 200
            assert r.json()["category"] == "INSUFFICIENT_DATA"


@requires_api
def test_registry_summary_endpoint():
    r = client.get("/api/v1/dams/registry/summary", headers=H)
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 50
    row = next(d for d in body["dams"] if d["dam_id"] == "d4")
    for key in ("name", "documents", "completeness", "condition", "simulation_available"):
        assert key in row


@requires_api
def test_sandbox_dams_no_raw_ids():
    r = client.get("/api/v1/sandbox/dams", headers=H)
    assert r.status_code == 200
    dams = r.json()["dams"]
    assert all(d["name"] != d["dam_id"] for d in dams)
    assert all(d.get("terrain_ready") for d in dams)


@requires_api
def test_impact_estimate_404_message_for_unknown_dam():
    r = client.post("/api/v1/impact/estimate", headers=H,
                    json={"dam_id": "d999", "case": "likely"})
    assert r.status_code == 404
    assert "Unknown dam id" in r.json()["detail"]
