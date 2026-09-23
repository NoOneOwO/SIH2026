"""
Sandbox smoke tests: engine determinism/physics sanity, API validation,
no-outcome-leak from the scenario agent. No DB, no network required.
"""

import base64

import numpy as np
import pytest

from app.sandbox import hydrograph as hydro
from app.sandbox import scenarios as agent
from app.sandbox import terrain_providers as tp
from app.sandbox.dam_registry import get_dam
from app.sandbox.engine import propagate, run_scenario
from app.sandbox.rivers import condition_domain
from app.sandbox.schemas import ScenarioParams

# Only the API smoke tests need the full service stack (sqlalchemy + DB
# config). The solver/physics tests below must run on a bare numpy install
# so the engine stays testable on a machine with no Postgres — an import
# error here used to abort collection for the entire module.
try:  # pragma: no cover - environment dependent
    from fastapi.testclient import TestClient

    from app.main import app as _app

    client = TestClient(_app, raise_server_exceptions=False)
    _API_SKIP: str | None = None
except Exception as _exc:  # pragma: no cover - environment dependent
    client = None
    _API_SKIP = f"API stack unavailable ({_exc})"

requires_api = pytest.mark.skipif(client is None, reason=_API_SKIP or "API stack unavailable")


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


@requires_api
def test_api_dams():
    r = client.get("/api/v1/sandbox/dams")
    assert r.status_code == 200
    assert r.json()["total"] > 20


@requires_api
def test_api_run_d4():
    body = {"dam_id": "d4", "scenario": _params().model_dump(), "grid_size": 48}
    r = client.post("/api/v1/sandbox/run", json=body)
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert j["summary"]["flooded_area_km2"] > 0
    arr = np.frombuffer(base64.b64decode(j["grids"]["arrival_min_b64"]), dtype=np.float32)
    assert arr.size == 48 * 48
    assert "NOT hydrodynamics" in j["summary"]["model"]


@requires_api
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


def test_closed_rim_never_teleports_water_to_the_opposite_edge():
    """A breach on the north rim of a flat, closed domain must not wet the
    south rim. The depth-relaxation stencil used to be toroidal (np.roll), so
    water crossed the seam of a domain whose borders are closed."""
    n = 32
    e = np.full((n, n), 100.0)
    p = _params(breach_location="0,16", breach_width_m=60.0,
                breach_depth_m=6.0, initial_release_m3=5000.0,
                duration_min=10.0)
    r = propagate(e, 30.0, p)
    assert r.maxdepth_m[0:2].max() > 1.0, "breach zone itself must be deep"
    assert r.maxdepth_m[-1].max() < 0.05, "water leaked across the closed rim"


def test_short_duration_run_is_never_empty():
    """duration*timestep used to truncate to zero steps, returning a run with
    no frames and no routing that still looked like a real answer."""
    e = _slope_elev()
    r = run_scenario(e, 30.0, _params(duration_min=1.0, timestep_s=600.0))
    assert r.steps_used >= 1
    assert len(r.frames) >= 1


def test_reported_peak_excludes_the_whole_breach_inlet():
    """A breach wider than 5 cells must not have its own inlet columns counted
    as downstream flooding: the source mask used to be a fixed 5x5 box."""
    n = 48
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    e = 100.0 - xx * 0.8 - yy * 0.1
    p = _params(breach_width_m=200.0, breach_depth_m=10.0)
    r = propagate(e, 30.0, p)  # 200 m / 30 m cells -> a 7-cell-wide inlet
    sr, sc = np.where(r.source_mask)
    assert sc.min() <= 21 and sc.max() >= 27, "inlet must be the full 7 columns"
    peak = float(r.maxdepth_m[~r.source_mask].max())
    inside = float(r.maxdepth_m[r.source_mask].max())
    assert peak < inside, "reported peak still includes inlet ponding"


def test_severity_classes_are_ordered_and_bounded():
    """Class 0 = below the 0.3 m first threshold (dry OR shallow), and the
    class ramp is strictly ordered so a deeper cell can never read lighter."""
    from app.sandbox.engine import SEVERITY_DEPTHS, severity_grid
    sev = severity_grid(np.array([[0.0, 0.1, 0.4, 1.2, 3.0, 6.0]]))
    assert sev.tolist()[0] == [0, 0, 1, 2, 3, 4]
    assert list(SEVERITY_DEPTHS) == sorted(SEVERITY_DEPTHS)


def test_extreme_class_agrees_with_critical_band():
    """The last severity depth and the consequence band's CRITICAL cutoff are
    the same number, so a mesh drawn in classes matches the band in words."""
    from app.sandbox.engine import SEVERITY_DEPTHS, severity_grid
    from app.sandbox.response import severity_band
    cutoff = SEVERITY_DEPTHS[-1]
    assert severity_band(cutoff, 0.0, 0) == "CRITICAL"
    assert severity_grid(np.array([[cutoff]]))[0][0] == 4
    assert severity_band(cutoff - 0.01, 0.0, 0) != "CRITICAL"


# ── D8 river conditioning ────────────────────────────────────────────

def _valley_elev(n=48):
    """V-valley draining south (+row): channel along center column."""
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    return 120.0 + 0.9 * np.abs(xx - n / 2) - yy * 0.6


def test_conditioning_deterministic():
    e = _valley_elev()
    c1 = condition_domain(e)
    c2 = condition_domain(e)
    np.testing.assert_array_equal(c1["elev"], c2["elev"])
    assert c1["channel"].tolist() == c2["channel"].tolist()
    assert c1["breach"] == c2["breach"]


def test_conditioning_finds_valley_channel_and_snaps_breach():
    e = _valley_elev()
    c = condition_domain(e)
    n = e.shape[0]
    assert c["channel"].sum() > n, "valley must read as a channel"
    # channel runs down the valley axis (center column band)
    col_frac = c["channel"][:, n // 2 - 2: n // 2 + 3].sum() / c["channel"].sum()
    assert col_frac > 0.6, f"channel should hug the valley, got {col_frac:.2f}"
    # breach snaps onto the river at the dam, not blind center
    br, bc = c["breach"]
    assert c["snapped"] and abs(bc - n // 2) <= 2
    assert c["stats"]["burn_max_m"] > 0


def test_conditioned_run_routes_down_valley():
    e = _valley_elev()
    r = run_scenario(e, 100.0, _params())
    assert r.conditioning and r.conditioning["channel_cells"] > 0
    n = e.shape[0]
    wet = r.maxdepth_m >= 0.05
    band = np.zeros_like(wet)
    band[:, n // 2 - 2: n // 2 + 3] = True
    frac = (wet & band).sum() / max(wet.sum(), 1)
    assert frac > 0.6, f"flood must follow the river, got {frac:.2f}"
    assert r.flooded_area_km2 > 0


def test_conditioned_run_conserves_mass():
    e = _slope_elev()
    r = run_scenario(e, 100.0, _params())
    assert abs(r.volume_stored_m3 - r.volume_in_m3) / r.volume_in_m3 < 1e-9


def test_conditioning_flat_plain_falls_back_to_center():
    e = np.full((48, 48), 100.0)  # no drainage at all
    c = condition_domain(e)
    assert c["breach"] == (24, 24) and not c["snapped"]


def test_inflow_trail_pushes_water_downstream():
    # Same release, point tap vs distributed trail: identical volume in,
    # but the wave front must carry a larger share downstream.
    e = _valley_elev()
    n = e.shape[0]
    p = _params()
    r_point = propagate(e, 100.0, p)
    r_wave = run_scenario(e, 100.0, p)
    assert abs(r_wave.volume_in_m3 - r_point.volume_in_m3) / r_point.volume_in_m3 < 1e-9
    assert r_wave.conditioning["inflow_cells"] > 3
    share_point = r_point.maxdepth_m[n // 2:, :].sum() / r_point.maxdepth_m.sum()
    br = r_wave.conditioning["breach_rc"][0]
    share_wave = r_wave.maxdepth_m[br:, :].sum() / r_wave.maxdepth_m.sum()
    assert share_wave > share_point


def test_weir_inflow_conserves_volume_and_peaks_early():
    e = _valley_elev()
    r = run_scenario(e, 100.0, _params())
    assert abs(r.volume_stored_m3 - r.volume_in_m3) / r.volume_in_m3 < 1e-6
    # seed mound (10 m over the 3x2 breach zone) + exact 2e6 weir release
    assert abs((r.volume_in_m3 - 600000.0) - 2e6) / 2e6 < 1e-6
    # early-peaked release: most volume enters in the first half
    assert r.frames and r.frames[0]["t_min"] < 60.0


def test_rainfall_alone_does_not_flood_the_domain():
    # 20 mm/h storm minus 12 mm/h abstraction on a flat plain: no cell may
    # cross the 0.05 m inundation cutoff from rain by itself.
    e = np.full((48, 48), 100.0)
    p = _params(breach_width_m=10.0, breach_depth_m=0.5,
                initial_release_m3=1000.0, rainfall_factor=1.0,
                duration_min=180.0)
    r = propagate(e, 100.0, p)
    assert r.flooded_area_km2 < 2.0, f"rain ponding leaked: {r.flooded_area_km2}"


@requires_api
def test_api_run_carries_river_conditioning():
    body = {"dam_id": "d4", "scenario": _params().model_dump(), "grid_size": 48}
    r = client.post("/api/v1/sandbox/run", json=body)
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert "channel-conditioned" in j["summary"]["model"]
    rc = j["river_conditioning"]
    assert rc["channel_cells"] > 0 and rc["burn_max_m"] > 0


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


@requires_api
def test_api_unknown_dam_404():
    r = client.post("/api/v1/sandbox/run", json={
        "dam_id": "dx-nope", "scenario": _params(dam_id="dx-nope").model_dump(), "grid_size": 32})
    assert r.status_code == 404


@requires_api
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
