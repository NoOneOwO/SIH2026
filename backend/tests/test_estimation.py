"""Impact-estimation tests: pipeline honesty, ranges, edge cases.

No DB and no network: the asset inventory is injected so only the model's own
logic is exercised. Terrain comes from the curated in-repo DEMs.
"""

import numpy as np
import pytest

from app.impact import estimation as est

# ── synthetic domain ────────────────────────────────────────────────────────
N = 40
CELL_M = 100.0
BBOX = [70.00, 22.00, 70.40, 22.40]   # west, south, east, north (0.01° ≈ 1.1 km)


def _flat_elev() -> np.ndarray:
    return np.full((N, N), 100.0)


def _drainage_elev() -> np.ndarray:
    """Slope down toward the south-east, so 'low ground' is bottom-right."""
    yy, xx = np.mgrid[0:N, 0:N].astype(float)
    return 100.0 + yy * 2.0 + xx * 1.5


def _depth_grid(wet_from: int = 20, depth: float = 1.6) -> np.ndarray:
    d = np.zeros((N, N), dtype=np.float64)
    d[wet_from:, :] = depth
    return d


def _arrival_grid(wet_from: int = 20, minutes: float = 45.0) -> np.ndarray:
    a = np.full((N, N), -1.0)
    a[wet_from:, :] = minutes
    return a


def _settlement(name="Testpur", lat=22.10, lon=70.10, kind="village", population=None):
    s = {"name": name, "kind": kind, "lat": lat, "lon": lon, "source": "osm"}
    if population is not None:
        s["population"] = population
    return s


def _estimate(depth=None, arrival=None, settlements=None, speed=None, elev=None,
              assets=None, provenance="osm-live", exposure_pct=None, runs=0, scenario=None,
              cell_m=CELL_M, engine="unit-test-engine"):
    return est.estimate_impact(
        depth_m=_depth_grid() if depth is None else depth,
        arrival_min=_arrival_grid() if arrival is None else arrival,
        bbox=BBOX, cell_m=cell_m,
        dam={"name": "Test Dam", "lat": 22.40, "lon": 70.00},
        settlements=settlements if settlements is not None else [_settlement()],
        assets=assets or [],
        engine=engine,
        assets_provenance=provenance,
        scenario=scenario or {"label": "likely", "initial_release_m3": 25e6,
                              "rainfall_factor": 1.0, "breach_width_m": 80.0},
        speed_ms=speed, elevation_m=elev if elev is not None else _flat_elev(),
        exposure_pct=exposure_pct, ensemble_runs=runs,
    )


# ── grid wrapper ────────────────────────────────────────────────────────────

def test_grid_index_round_trips_and_rejects_outside():
    g = est.Grid(np.zeros((10, 20)), 50.0, [70.0, 22.0, 70.2, 22.1])
    r, c = g.index(22.05, 70.10)
    assert 0 <= r < 10 and 0 <= c < 20
    assert g.index(21.0, 70.1) is None          # south of the domain
    assert g.index(22.05, 80.0) is None         # east of the domain
    assert g.index(float("nan"), 70.1) is None  # missing coordinates


def test_grid_handles_rectangular_domains():
    g = est.Grid(np.zeros((12, 30)), 25.0, [70.0, 22.0, 70.3, 22.1])
    r, c = g.index(22.10, 70.30)
    assert (r, c) == (0, 29)


# ── hazard → status ─────────────────────────────────────────────────────────

def test_inundated_settlement_gets_depth_arrival_and_risk():
    rows = _estimate()["settlements"]
    assert len(rows) == 1
    s = rows[0]
    assert s["status"] == "INUNDATED"
    assert s["depth_m"] == pytest.approx(1.6, abs=1e-6)
    assert s["arrival_min"] == pytest.approx(45.0, abs=1e-6)
    assert s["risk"] in ("HIGH", "EXTREME")
    assert s["lead_time_min"] == pytest.approx(30.0, abs=1e-6)


def test_dry_settlement_far_from_water_is_safe_with_no_impact():
    # Water occupies rows 20+ (the SOUTHERN half: row 0 is the north edge),
    # so a settlement far to the north stays dry.
    e = _estimate(settlements=[_settlement(lat=22.38, lon=70.01)])
    s = e["settlements"][0]
    assert s["status"] == "SAFE"
    assert s["risk"] == "LOW"
    assert s["population_exposed"]["mid"] == 0
    assert s["damage"]["total"]["mid_inr"] == 0
    assert s["savings"]["avoided"]["mid_inr"] == 0


def test_dry_settlement_next_to_water_is_at_risk_not_inundated():
    # Two cells north of the waterline: dry under the 3×3 footprint sample, but
    # inside the documented "near water" range.
    depth = _depth_grid(wet_from=20)
    lat_two_cells_up = 22.40 - (20 - 2) * 0.01
    e = _estimate(depth=depth, arrival=_arrival_grid(20),
                  settlements=[_settlement(lat=lat_two_cells_up, lon=70.10)])
    s = e["settlements"][0]
    assert s["status"] == "AT RISK"
    assert s["depth_m"] < est.WET_THRESHOLD_M
    assert s["population_exposed"]["mid"] > 0            # contingency exposure
    assert s["risk"] == "MODERATE"


def test_no_flood_at_all_produces_a_clean_zero_state():
    depth = np.zeros((N, N))
    arrival = np.full((N, N), -1.0)
    e = _estimate(depth=depth, arrival=arrival,
                  settlements=[_settlement(), _settlement(name="Two", lat=22.2, lon=70.2)])
    assert e["totals"]["flooded_area_km2"] == 0.0
    assert e["totals"]["population_exposed"]["mid"] == 0
    assert e["totals"]["damage"]["mid_inr"] == 0
    assert {s["status"] for s in e["settlements"]} == {"SAFE"}
    assert e["totals"]["overall_risk"] == "LOW"


# ── population nowcasting ───────────────────────────────────────────────────

def test_osm_population_tag_is_observed_and_exact():
    e = _estimate(settlements=[_settlement(population="210000")])
    pop = e["settlements"][0]["population"]
    assert pop["basis"] == "observed"
    assert pop["value"] == 210_000
    assert pop["range"]["low"] == pop["range"]["high"] == 210_000


def test_missing_population_falls_back_to_labelled_class_median():
    e = _estimate(settlements=[_settlement(kind="hamlet")])
    pop = e["settlements"][0]["population"]
    assert pop["basis"] == "modelled"
    assert pop["value"] == est.POPULATION_CLASS_MEDIAN["hamlet"]
    assert pop["range"]["low"] < pop["value"] < pop["range"]["high"]


def test_population_ranges_are_monotonic_and_integral():
    e = _estimate(settlements=[_settlement(population=40000)])
    s = e["settlements"][0]
    for key in ("population_exposed", "population_displaced"):
        block = s[key]
        assert block["low"] <= block["mid"] <= block["high"]
        assert all(isinstance(block[k], int) for k in ("low", "mid", "high"))
    assert s["population_displaced"]["mid"] <= s["population_exposed"]["mid"]


# ── exposure / vulnerability / impact consistency ──────────────────────────

def test_exposure_share_increases_with_depth():
    shallow = _estimate(depth=_depth_grid(depth=0.2))["settlements"][0]
    deep = _estimate(depth=_depth_grid(depth=3.0))["settlements"][0]
    assert shallow["population_exposed"]["mid"] < deep["population_exposed"]["mid"]
    assert shallow["vulnerability"]["score"] < deep["vulnerability"]["score"]
    assert shallow["damage"]["total"]["mid_inr"] < deep["damage"]["total"]["mid_inr"]


def test_lead_time_reduces_displacement_and_raises_savings():
    early = _estimate(arrival=_arrival_grid(minutes=200))["settlements"][0]
    late = _estimate(arrival=_arrival_grid(minutes=25))["settlements"][0]
    assert early["population_displaced"]["mid"] < late["population_displaced"]["mid"]
    assert early["savings"]["effectiveness"] > late["savings"]["effectiveness"]
    assert early["savings"]["avoided"]["mid_inr"] > late["savings"]["avoided"]["mid_inr"]


def test_avoided_never_exceeds_total_damage():
    e = _estimate(settlements=[_settlement(population=50000)])
    assert e["totals"]["avoided"]["mid_inr"] <= e["totals"]["damage"]["mid_inr"]
    assert e["totals"]["residual_damage"]["mid_inr"] == (
        e["totals"]["damage"]["mid_inr"] - e["totals"]["avoided"]["mid_inr"])


def test_money_ranges_bracket_the_midpoint():
    e = _estimate(settlements=[_settlement(population=12000)])
    d = e["totals"]["damage"]
    assert d["low_inr"] < d["mid_inr"] < d["high_inr"]
    a = e["totals"]["avoided"]
    assert a["low_inr"] <= a["mid_inr"] <= a["high_inr"]


def test_mapped_facilities_raise_infrastructure_loss():
    base = _estimate(settlements=[_settlement(population=5000)])
    facility = {"name": "District Hospital", "kind": "hospital", "lat": 22.10,
                "lon": 70.10, "source": "osm"}
    with_hospital = _estimate(settlements=[_settlement(population=5000)], assets=[facility])
    assert with_hospital["settlements"][0]["damage"]["infrastructure"]["mid_inr"] > \
        base["settlements"][0]["damage"]["infrastructure"]["mid_inr"]
    assert with_hospital["totals"]["critical_assets_exposed"] == 1
    assert "hospital" in with_hospital["settlements"][0]["facilities_exposed"]


def test_agricultural_loss_tracks_flooded_area():
    small = _estimate(depth=_depth_grid(wet_from=35))
    big = _estimate(depth=_depth_grid(wet_from=10))
    assert big["totals"]["agriculture"]["area_km2"] > small["totals"]["agriculture"]["area_km2"]
    assert big["totals"]["damage_breakdown"]["agriculture_inr"] > 0
    assert (big["totals"]["damage_breakdown"]["residential_inr"]
            + big["totals"]["damage_breakdown"]["commercial_inr"]
            + big["totals"]["damage_breakdown"]["infrastructure_inr"]
            + big["totals"]["damage_breakdown"]["agriculture_inr"]) == big["totals"]["damage"]["mid_inr"]


# ── evidence classes / honesty rules ───────────────────────────────────────

def test_engine_without_velocity_reports_no_hazard_index():
    s = _estimate(settlements=[_settlement(population=1000)])["settlements"][0]
    assert s["hazard_index"] is None
    assert "not available" in s["hazard_index_basis"]
    assert s["speed_ms"] is None


def test_velocity_field_produces_a_depth_velocity_index():
    speed = np.zeros((N, N))
    speed[20:, :] = 2.5
    s = _estimate(speed=speed, settlements=[_settlement(population=1000)])["settlements"][0]
    assert s["hazard_index"] == pytest.approx(1.6 * 2.5, abs=1e-3)
    assert s["speed_ms"] == pytest.approx(2.5, abs=1e-3)


def test_every_published_block_declares_its_evidence_class():
    e = _estimate(settlements=[_settlement(population=9000)])
    s = e["settlements"][0]
    for block in ("population", "population_exposed", "population_displaced", "damage",
                  "savings", "vulnerability"):
        assert s[block]["basis"] in ("observed", "derived", "modelled", "assumed")
    assert e["confidence"]["basis"] in ("observed", "derived", "modelled", "assumed")
    assert s["confidence"] == e["confidence"]["level"]
    assert set(e["evidence_legend"]) == {"observed", "derived", "modelled", "assumed"}
    assert e["totals"]["damage"]["basis"] == "modelled"
    assert "estimated" in e["totals"]["avoided"]["basis_note"].lower()
    assert len(e["assumptions"]) >= 10
    assert all(a["stage"] and a["parameter"] and a["note"] for a in e["assumptions"])
    assert len(e["method"]) >= 8 and len(e["limits"]) >= 3


# ── confidence ──────────────────────────────────────────────────────────────

def test_confidence_drops_with_coarse_inputs_and_rises_with_ensemble():
    good = _estimate(settlements=[_settlement(population=1000)], provenance="osm-live", runs=10)["confidence"]
    poor = _estimate(settlements=[_settlement()], provenance="modeled-fallback",
                     elev=np.full((N, N), 100.0))["confidence"]
    assert good["score"] > poor["score"]
    assert poor["level"] in ("Low", "Medium")
    assert all(f["penalty"] >= 0 for f in poor["factors"])
    assert any("scenario runs" in f["factor"] for f in good["factors"])


def test_confidence_reflects_the_engine_and_grid_quality():
    screening = _estimate(settlements=[_settlement(population=1000)], provenance="osm-live")["confidence"]
    hydraulic = _estimate(settlements=[_settlement(population=1000)], provenance="osm-live",
                          cell_m=25.0, engine="lisflood-fp-5.9")["confidence"]
    assert screening["level"] in ("Low", "Medium")
    assert hydraulic["level"] == "High"
    assert hydraulic["score"] > screening["score"]


def test_confidence_never_claims_certainty():
    for kwargs in ({"runs": 24}, {"cell_m": 5.0, "engine": "lisflood-fp-5.9"}):
        e = _estimate(settlements=[_settlement(population=1000)], provenance="osm-live", **kwargs)
        assert 5.0 <= e["confidence"]["score"] < 100.0
    assert "penalties" in _estimate(settlements=[_settlement()])["confidence"]["basis_note"]


def test_confidence_level_propagates_to_every_settlement_row():
    e = _estimate(settlements=[_settlement(), _settlement(name="B", lat=22.2, lon=70.2)])
    assert {r["confidence"] for r in e["settlements"]} == {e["confidence"]["level"]}


# ── ensemble likelihood, drivers, ordering ─────────────────────────────────

def test_ensemble_exposure_frequency_is_passed_through_verbatim():
    pct = np.zeros((N, N), dtype=np.float32)
    pct[20:, :] = 70.0
    e = _estimate(exposure_pct=pct, settlements=[_settlement()], runs=10)
    assert e["settlements"][0]["inundation_likelihood_pct"] == 70.0
    assert any("10 scenario runs" in f["factor"] for f in e["confidence"]["factors"])


def test_no_ensemble_means_no_invented_likelihood():
    e = _estimate(settlements=[_settlement()])
    assert e["settlements"][0]["inundation_likelihood_pct"] is None
    assert not any("scenario runs" in f["factor"] for f in e["confidence"]["factors"])


def test_settlements_are_ranked_by_exposed_population():
    settlements = [_settlement(name="Small", lat=22.10, lon=70.10, population=500),
                   _settlement(name="Big", lat=22.10, lon=70.15, population=90000)]
    rows = _estimate(settlements=settlements)["settlements"]
    assert [r["name"] for r in rows] == ["Big", "Small"]
    assert rows[0]["population_exposed"]["mid"] > rows[1]["population_exposed"]["mid"]


def test_drivers_are_ranked_and_cite_values():
    e = _estimate(settlements=[_settlement(population=1000)])
    assert len(e["drivers"]) >= 4
    for d in e["drivers"]:
        assert d["factor"] and d["value"] and d["note"]
        assert d["direction"] in ("up", "down")


def test_settlements_outside_the_domain_are_dropped_not_extrapolated():
    e = _estimate(settlements=[_settlement(), _settlement(name="Faraway", lat=10.0, lon=10.0)])
    assert [s["name"] for s in e["settlements"]] == ["Testpur"]


def test_missing_coordinates_do_not_crash():
    e = _estimate(settlements=[{"name": "Ghost", "kind": "village", "lat": None, "lon": None}])
    assert e["settlements"] == []
    assert e["totals"]["settlements_assessed"] == 0


def test_extreme_depth_saturates_but_stays_bounded():
    e = _estimate(depth=_depth_grid(depth=12.0), arrival=_arrival_grid(minutes=5),
                  settlements=[_settlement(kind="city", population=400000)])
    s = e["settlements"][0]
    assert s["severity_band"] == "EXTREME"
    assert s["risk"] == "EXTREME"
    assert s["population_exposed"]["mid"] <= 400000
    assert 0.0 <= s["vulnerability"]["score"] <= 1.0
    assert e["totals"]["population_displaced"]["mid"] < e["totals"]["population_exposed"]["mid"]


def test_payload_is_json_serialisable():
    import json
    json.dumps(_estimate(settlements=[_settlement(population=1000)]))


# ── orchestration glue (engine → estimator), no rasterio / network ─────────

FAKE_ASSETS = [
    {"name": "Bhalbhal", "kind": "village", "lat": 22.10, "lon": 70.10, "source": "osm", "population": "5000"},
    {"name": "Riverbridge", "kind": "bridge", "lat": 22.09, "lon": 70.10, "source": "osm"},
    {"name": "Nowhere", "kind": "village", "lat": 12.0, "lon": 12.0, "source": "osm"},
]


def test_run_case_wires_engine_and_estimator(monkeypatch):
    from app.sandbox import impact_run

    def fake_elev(dam_id, grid_size):
        yy, xx = np.mgrid[0:N, 0:N].astype(float)
        return 120.0 - yy * 0.5 - xx * 2.0, CELL_M, list(BBOX)

    monkeypatch.setattr(impact_run, "load_elevation", fake_elev)
    monkeypatch.setattr(impact_run, "_resolve_meta", lambda dam_id: {
        "dam_id": dam_id, "name": "Fake Dam", "lat": 22.40, "lon": 70.00, "terrain": {"source": "test"}})
    monkeypatch.setattr(impact_run.assets_mod, "load_assets",
                        lambda dam_id, lat, lon: (FAKE_ASSETS, "osm-cache"))

    out = impact_run.run_case("d4", case="worst", grid_size=N, ensemble_count=6, seed=5)
    est_payload = out["estimate"]

    # Only mapped settlements inside the domain are assessed.
    assert [s["name"] for s in est_payload["settlements"]] == ["Bhalbhal"]
    assert est_payload["dam"]["name"] == "Fake Dam"
    assert est_payload["totals"]["flooded_area_km2"] >= 0.0
    # Ensemble frequency is real (6 runs) and carried into confidence.
    assert out["ensemble"]["runs"] == 6
    assert any("6 scenario runs" in f["factor"] for f in est_payload["confidence"]["factors"])
    # Population came from the OSM tag, so it stays an observed value.
    assert est_payload["settlements"][0]["population"]["basis"] == "observed"
    assert out["asset_provenance"] == "osm-cache"
    assert "modelled estimates" in out["mode"]


def test_run_case_rejects_unknown_case():
    from app.sandbox import impact_run

    with pytest.raises(ValueError):
        impact_run.run_case("d4", case="apocalyptic")
