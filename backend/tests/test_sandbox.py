"""
Sandbox smoke tests: engine determinism/physics sanity, API validation,
no-outcome-leak from the scenario agent. No DB, no network required.
"""

import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.sandbox import hydrograph as hydro
from app.sandbox import scenarios as agent
from app.sandbox import terrain_providers as tp
from app.sandbox.dam_registry import get_dam
from app.sandbox.engine import propagate
from app.sandbox.schemas import ScenarioParams

client = TestClient(app, raise_server_exceptions=False)


def _slope_elev(n=48):
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    return 100.0 - xx * 0.8 - yy * 0.1  # drains toward +x (east)


def _params(**kw):
    d = dict(dam_id="d4", label="test", reservoir_level_m=100.0,
             breach_location="dam", breach_width_m=200.0, breach_depth_m=10.0,
             breach_severity="major", initial_release_m3=2e6, roughness=0.05,
             rainfall_factor=0.0, duration_min=60.0, timestep_s=60.0, seed=7)
    d.update(kw)
    return ScenarioParams(**d)


def test_engine_deterministic():
    e = _slope_elev()
    r1 = propagate(e, 100.0, _params())
    r2 = propagate(e, 100.0, _params())
    np.testing.assert_array_equal(r1.arrival_min, r2.arrival_min)
    np.testing.assert_array_equal(r1.maxdepth_m, r2.maxdepth_m)


def test_engine_flows_downhill_not_uphill():
    e = _slope_elev()
    r = propagate(e, 100.0, _params())
    n = e.shape[0]
    # breach at center: east (downhill) must flood more than west (uphill)
    east = (r.maxdepth_m[:, n // 2:] >= 0.05).sum()
    west = (r.maxdepth_m[:, : n // 2] >= 0.05).sum()
    assert east > west
    assert r.flooded_area_km2 > 0


def test_engine_mass_sanity():
    e = _slope_elev()
    r = propagate(e, 100.0, _params())
    # closed domain, no rain: stored == released
    assert abs(r.volume_stored_m3 - r.volume_in_m3) / r.volume_in_m3 < 1e-9


def test_scenario_validation():
    with pytest.raises(Exception):
        _params(breach_width_m=-5)
    with pytest.raises(Exception):
        _params(roughness=99)


def test_agent_produces_params_not_outcomes():
    t = agent.generate_triplet("d4")
    for label in ("best", "likely", "worst"):
        assert isinstance(t[label], ScenarioParams)
    blob = t["best"].model_dump_json() + t["worst"].model_dump_json()
    assert "flooded" not in blob and "arrival" not in blob
    ens = agent.generate_ensemble("d4", count=5, seed=1)
    assert len(ens) == 5 and len({s.seed for s in ens}) == 5


def test_api_dams():
    r = client.get("/api/v1/sandbox/dams")
    assert r.status_code == 200
    assert r.json()["total"] > 20


def test_api_run_d4():
    body = {"dam_id": "d4", "scenario": _params().model_dump(), "grid_size": 48}
    r = client.post("/api/v1/sandbox/run", json=body)
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert j["summary"]["flooded_area_km2"] > 0
    arr = np.frombuffer(base64.b64decode(j["grids"]["arrival_min_b64"]), dtype=np.float32)
    assert arr.size == 48 * 48
    assert "NOT hydrodynamics" in j["summary"]["model"]


def test_api_ensemble_small():
    body = {"dam_id": "d4", "count": 3, "seed": 11, "grid_size": 32}
    r = client.post("/api/v1/sandbox/ensemble", json=body)
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert set(j["comparison"]) == {"best", "likely", "worst"}
    assert "NOT statistical guarantees" in j["exposure_classes"]


# ── Hydrograph guarantees ──────────────────────────────────────────

def _hydro(**kw):
    d = dict(breach_width_m=80.0, breach_depth_m=20.0, release_m3=25e6,
             formation_min=45.0, duration_min=180.0, dt_s=60.0)
    d.update(kw)
    return hydro.compute_hydrograph(**d)


def test_hydrograph_guarantees():
    h = _hydro()
    q = np.array(h["discharge_m3s"])
    c = np.array(h["cumulative_m3"])
    assert (q >= 0).all()
    assert (np.diff(c) >= -1e-9).all(), "cumulative volume must be monotonic"
    assert abs(h["total_volume_m3"] - 25e6) / 25e6 < 1e-6
    assert h["peak_discharge_m3s"] > 0 and 0 <= h["time_to_peak_min"] <= 180.0


def test_hydrograph_params_matter():
    base = _hydro()["peak_discharge_m3s"]
    assert _hydro(breach_width_m=400.0)["peak_discharge_m3s"] > base
    assert _hydro(breach_depth_m=60.0)["peak_discharge_m3s"] > base
    assert _hydro(formation_min=10.0)["time_to_peak_min"] <= _hydro(formation_min=120.0)["time_to_peak_min"]
    v = _hydro(release_m3=100e6)
    assert abs(v["total_volume_m3"] - 100e6) / 100e6 < 1e-6


def test_engine_frames_are_computed_states():
    e = _slope_elev()
    r = propagate(e, 100.0, _params())
    assert r.frames and len(r.frames) >= 3
    areas = [f["flooded_area_km2"] for f in r.frames]
    assert areas[-1] >= areas[0] - 1e-9, "flood extent must not shrink overall"
    assert all(f["volume_stored_m3"] >= 0 for f in r.frames)
    ts = [f["t_min"] for f in r.frames]
    assert ts == sorted(ts) and ts[-1] <= 60.0 + 1e-9


# ── Registry + providers (no network) ──────────────────────────────

def test_registry_d52_idukki():
    d = get_dam("d52")
    assert d and d["name"] == "Idukki Dam"
    assert abs(d["lat"] - 9.83) < 0.01 and abs(d["lon"] - 76.98) < 0.01
    assert get_dam("nope") is None


def test_provider_tile_math():
    assert tp.tiles_for_bbox((76.9, 9.78, 77.06, 9.88)) == [(9, 76), (9, 77)]
    url = tp.copernicus_cog_url(9, 76, 30)
    assert url == ("https://copernicus-dem-30m.s3.amazonaws.com/"
                   "Copernicus_DSM_COG_10_N09_00_E076_00_DEM/"
                   "Copernicus_DSM_COG_10_N09_00_E076_00_DEM.tif")
    url90 = tp.copernicus_cog_url(30, 78, 90)
    assert "copernicus-dem-90m" in url90 and "COG_30_N30_00_E078_00" in url90


def test_provider_chain_fails_closed_without_network_or_keys(monkeypatch):
    monkeypatch.delenv("CDSE_S3_ACCESS_KEY", raising=False)
    monkeypatch.delenv("CDSE_S3_SECRET_KEY", raising=False)
    monkeypatch.delenv("OPENTOPOGRAPHY_API_KEY", raising=False)
    for i in range(1, 4):
        monkeypatch.delenv(f"OPENTOPOGRAPHY_API_KEY_{i}", raising=False)
    monkeypatch.delenv("OPENTOPO_KEYS", raising=False)
    import tempfile
    from pathlib import Path
    empty = Path(tempfile.mkdtemp())
    with pytest.raises(tp.TerrainUnavailableError) as ei:
        # bbox over ocean void + empty local roots: every provider must fail
        tp.ensure_dem("dx-void", 0.0, 0.0, [empty], empty, radius_km=0.5)
    assert len(ei.value.trail) >= 4  # local, glo30, glo90, cdse, ot all recorded


def test_api_unknown_dam_404():
    r = client.post("/api/v1/sandbox/run", json={
        "dam_id": "dx-nope", "scenario": _params(dam_id="dx-nope").model_dump(), "grid_size": 32})
    assert r.status_code == 404


def test_api_run_schema_d52():
    """Mandatory Idukki path: real terrain → hydrograph → frames → assets."""
    body = {"dam_id": "d52", "scenario": _params(dam_id="d52").model_dump(), "grid_size": 48}
    r = client.post("/api/v1/sandbox/run", json=body)
    assert r.status_code == 200, r.text[:500]
    j = r.json()
    assert j["mode"] == "REAL COMPUTED SIMULATION"
    assert j["terrain"]["source"] and j["terrain"]["dataset"]
    assert j["hydrograph"]["peak_discharge_m3s"] > 0
    assert len(j["frames"]) >= 3
    assert j["summary"]["severity_band"] in ("MODERATE", "HIGH", "VERY HIGH", "CRITICAL")
    assert "solver_version" in j["provenance"]
