"""DamSafe Twin — transparent flood-impact estimation pipeline.

Chain implemented here (each stage is a separate, testable function):

    HAZARD  ->  EXPOSURE  ->  VULNERABILITY  ->  IMPACT  ->  ECONOMIC LOSS
                                                          ->  AVOIDED LOSS

WHY THIS MODULE EXISTS
----------------------
Flood forecasts are uncertain, and a dam-break study has no historical record
to calibrate against. Rather than emitting single confident-looking numbers,
this module emits **ranges + a confidence level + the evidence class of every
input**, so the UI can never present an assumption as a measurement.

EVIDENCE CLASSES (attached to every published value)
----------------------------------------------------
    OBSERVED  read from a data source with no interpretation
              (OSM tags, DEM samples, engine output grids)
    DERIVED   arithmetic on observed values (distances, areas, sums)
    MODELLED  produced by a documented model whose parameters are tunable
              (engine depth/arrival, damage curves, confidence score)
    ASSUMED   a chosen planning parameter (unit costs, footprint fractions);
              always overridable and always published in `assumptions`

SIMULATION IS NOT OBSERVATION. Depth/arrival/speed come from a numerical
model, so they are classed MODELLED even though the engine itself is real
computation — the model is the model, not the river.

UNITS
-----
    depth / elevation   metres (m)
    arrival / lead time minutes (min)
    speed               metres per second (m/s)
    area                square kilometres (km²)
    money               Indian Rupees (INR), unrounded integers
    population          persons (counts; ranges where the source is modelled)
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

import numpy as np

from app.impact.grids import overground_distance_m

# ─────────────────────────────────────────────────────────────────────────────
# Documented model parameters. Every entry here is an ASSUMPTION and is
# published verbatim in the payload's `assumptions` block so the interface can
# show the reasoning behind every rupee and every person.
# ─────────────────────────────────────────────────────────────────────────────

WET_THRESHOLD_M = 0.05          # a cell counts as inundated at/above this depth
AT_RISK_RANGE_CELLS = 2         # dry settlement within N cells of water = AT RISK

# Population fallback per OSM place class (persons). Used ONLY when the
# settlement has no observed `population` tag; label stays MODELLED.
POPULATION_CLASS_MEDIAN = {
    "city": 150_000,
    "town": 12_000,
    "village": 1_200,
    "hamlet": 180,
    "suburb": 8_000,
    "unknown": 800,
}
# Multiplicative range applied to a modelled population median (±).
POPULATION_RANGE = (0.5, 1.6)

# Share of a settlement's residents assumed inside the inundated footprint,
# by peak water depth at the settlement. Deeper water generally means a larger
# share of the built-up area is flooded, but never all of it (high ground,
# multi-storey buildings, embanked cores stay dry).
POP_EXPOSURE_BY_DEPTH = (
    (0.30, 0.15),   # nuisance flooding  -> ~15% of residents in the wet area
    (1.00, 0.35),
    (2.50, 0.60),
    (float("inf"), 0.80),
)
AT_RISK_EXPOSURE = 0.05  # dry-but-adjacent settlements: 5% contingency

# Share of the exposed population that is expected to need temporary
# relocation (vs. sheltering in place / moving upstairs).
DISPLACEMENT_BASE = 0.35
DISPLACEMENT_DEPTH_UPLIFT = 0.25   # added at extreme depth
DISPLACEMENT_LEAD_RELIEF = 0.25    # multiplied down by good warning lead time

# Depth -> damage. Fraction of the exposed asset value lost at peak depth
# (standard depth-damage curve shape; planning grade, not surveyed).
DAMAGE_FACTOR_BY_DEPTH = (
    (WET_THRESHOLD_M, 0.00),
    (0.30, 0.15),
    (1.00, 0.35),
    (2.50, 0.60),
    (float("inf"), 0.80),
)

# Depth -> severity band, ascending (mirrors the engine's own banding so the
# globe and the tables never disagree). The final row must be open-ended:
# `_band` returns the first row whose threshold is >= the value.
SEVERITY_BANDS = (
    (WET_THRESHOLD_M, "MINOR"),
    (0.30, "LOW"),
    (1.00, "MODERATE"),
    (2.50, "HIGH"),
    (float("inf"), "EXTREME"),
)

# ── Economic unit rates (planning-level, INR) ────────────────────────────────
UNIT_RESIDENTIAL_PER_PERSON_INR = 250_000     # household + movable assets
COMMERCIAL_UPLIFT_URBAN = 0.35                # extra commercial/industrial value
COMMERCIAL_UPLIFT_RURAL = 0.10
UNIT_INFRASTRUCTURE_INR = {
    "bridge": 80_000_000,
    "hospital": 250_000_000,
    "school": 30_000_000,
    "substation": 50_000_000,
    "plant": 500_000_000,
    "power": 50_000_000,
    "police_station": 15_000_000,
    "telecom_tower": 8_000_000,
    "default": 10_000_000,
}
CROP_VALUE_PER_HA_INR = 65_000               # one season, rain-fed cropland
AGRICULTURAL_SHARE_OF_FLOODED_AREA = 0.55    # non-built share assumed cropland

# Uncertainty applied to modelled money and population (fractional spread).
MONEY_SPREAD = 0.35
POPULATION_SPREAD = 0.30

# ── Early-action effectiveness (avoided loss), by usable warning lead time ──
# Fraction of *movable* exposure saved by warning + evacuation + asset
# protection. Fixed infrastructure damage is largely not avoidable, so it is
# credited a small fraction of the same curve.
AVOIDANCE_BY_LEAD_TIME = (
    (0.0, 0.00),
    (30.0, 0.10),
    (60.0, 0.18),
    (180.0, 0.26),
    (360.0, 0.32),
    (float("inf"), 0.38),
)
FIXED_INFRASTRUCTURE_AVOIDANCE_SHARE = 0.15
MOBILISATION_TIME_MIN = 15.0   # alert -> people actually moving

# ── Evacuation screening (used by app.impact.evacuation) ────────────────────
EVAC_SPEED_KMH = 40.0          # assumed average speed on major roads (planning)
EVAC_MAX_CORRIDORS = 6         # candidate corridors returned per run

# ── Confidence scoring ──────────────────────────────────────────────────────
CONFIDENCE_PENALTIES = {
    "engine_screening": 20.0,
    "engine_hydraulic": 5.0,
    "assets_modelled": 20.0,
    "assets_osm_cached": 5.0,
    "assets_osm_live": 2.0,
    "population_modelled": 15.0,
    "grid_coarse": 18.0,
    "grid_medium": 10.0,
    "grid_fine": 4.0,
    "arrival_missing": 8.0,
}
CONFIDENCE_ENSEMBLE_BONUS = 8.0
CONFIDENCE_HIGH_MIN = 75.0
CONFIDENCE_MEDIUM_MIN = 55.0


# ─────────────────────────────────────────────────────────────────────────────
# small numeric helpers
# ─────────────────────────────────────────────────────────────────────────────

def _band(value: float, table: Sequence[tuple[float, Any]], default: Any) -> Any:
    """First row whose threshold is >= value (tables are ascending)."""
    for threshold, result in table:
        if value <= threshold:
            return result
    return default


def severity_band(depth_m: float) -> str:
    """Bands for depths below the inundation threshold are DRY, not MINOR."""
    if depth_m < WET_THRESHOLD_M:
        return "DRY"
    return _band(depth_m, SEVERITY_BANDS, "EXTREME")


def hazard_index(depth_m: float, speed_ms: float) -> float:
    """h · √(u²+v²) — the depth-velocity product already used platform-wide."""
    if depth_m <= 0:
        return 0.0
    return float(depth_m * math.sqrt(speed_ms ** 2))


# Display risk bands, worst last.
_RISK_ORDER = {"LOW": 0, "MODERATE": 1, "HIGH": 2, "EXTREME": 3}


def _risk_from_hazard(index: float | None, depth_m: float, exposed_pop: float) -> str:
    """Display risk band: hazard first, escalated for heavy population loads.

    `index` is None when the engine produced no velocity field; the depth and
    population thresholds then carry the band on their own (documented, not
    silently substituted with a made-up velocity).
    """
    if depth_m < WET_THRESHOLD_M:
        return "LOW"
    h = index or 0.0
    if h >= 8.0 or depth_m >= 2.5 or (depth_m >= 1.0 and exposed_pop >= 20_000):
        return "EXTREME"
    if h >= 2.5 or depth_m >= 1.0 or exposed_pop >= 5_000:
        return "HIGH"
    if depth_m >= 0.30:
        return "MODERATE"
    return "LOW"


def _money_range(mid: float) -> dict:
    low = max(0.0, mid * (1.0 - MONEY_SPREAD))
    high = mid * (1.0 + MONEY_SPREAD)
    return {"low_inr": int(round(low)), "mid_inr": int(round(mid)), "high_inr": int(round(high))}


def _pop_range(mid: float) -> dict:
    """Population range. Counts stay integers and never go below zero."""
    low = max(0.0, mid * (1.0 - POPULATION_SPREAD))
    high = mid * (1.0 + POPULATION_SPREAD)
    return {"low": int(round(low)), "mid": int(round(mid)), "high": int(round(high))}


# ─────────────────────────────────────────────────────────────────────────────
# gridded sampling
# ─────────────────────────────────────────────────────────────────────────────

class Grid:
    """Regular lat/lon grid wrapper: row 0 = north edge (engine convention).

    Grids may be rectangular (the LISFLOOD domain is nrows × ncols), so row and
    column counts are tracked separately everywhere.
    """

    def __init__(self, arr: np.ndarray, cell_m: float, bbox: Sequence[float]):
        self.arr = arr
        self.nrows = int(arr.shape[0])
        self.ncols = int(arr.shape[1]) if arr.ndim > 1 else 1
        self.cell_m = float(cell_m)
        self.west, self.south, self.east, self.north = (float(v) for v in bbox)

    def index(self, lat: float, lon: float) -> tuple[int, int] | None:
        """Nearest (row, col) for a coordinate, or None when outside the grid."""
        if not (math.isfinite(lat) and math.isfinite(lon)):
            return None
        span_lon = self.east - self.west
        span_lat = self.north - self.south
        if span_lon <= 0 or span_lat <= 0:
            return None
        fx = (lon - self.west) / span_lon
        fy = (self.north - lat) / span_lat
        if not (-0.02 <= fx <= 1.02 and -0.02 <= fy <= 1.02):
            return None
        c = int(np.clip(round(fx * (self.ncols - 1)), 0, self.ncols - 1))
        r = int(np.clip(round(fy * (self.nrows - 1)), 0, self.nrows - 1))
        return r, c

    def patch_max(self, r: int, c: int, radius: int = 1) -> float:
        """Max value in a (2r+1)² neighbourhood — areal rather than point sample."""
        r0, r1 = max(0, r - radius), min(self.nrows, r + radius + 1)
        c0, c1 = max(0, c - radius), min(self.ncols, c + radius + 1)
        sub = self.arr[r0:r1, c0:c1]
        if sub.size == 0:
            return 0.0
        return float(np.nanmax(sub))

    def patch_min_positive(self, r: int, c: int, radius: int = 1) -> float | None:
        r0, r1 = max(0, r - radius), min(self.nrows, r + radius + 1)
        c0, c1 = max(0, c - radius), min(self.ncols, c + radius + 1)
        sub = self.arr[r0:r1, c0:c1]
        wet = sub[sub >= 0]
        if wet.size == 0:
            return None
        return float(wet.min())


def distance_to_wet_m(grid: Grid, r: int, c: int, wet: np.ndarray) -> float | None:
    """Straight-line distance from a cell to the nearest inundated cell (m)."""
    if not wet.any():
        return None
    rows, cols = np.nonzero(wet)
    d = np.hypot(rows - r, cols - c) * grid.cell_m
    return float(d.min())


# ─────────────────────────────────────────────────────────────────────────────
# population nowcasting
# ─────────────────────────────────────────────────────────────────────────────

def resolution_population(settlement: dict) -> dict:
    """Observed population tag when present, else a labelled class median."""
    raw = settlement.get("population")
    try:
        value = float(raw) if raw not in (None, "", "0") else 0.0
    except (TypeError, ValueError):
        value = 0.0
    if value > 0:
        return {
            "value": int(round(value)),
            "basis": "observed",
            "basis_note": "OpenStreetMap `population` tag on the settlement node",
            "range": {"low": int(round(value)), "mid": int(round(value)), "high": int(round(value))},
        }
    kind = str(settlement.get("kind") or "unknown").lower()
    median = POPULATION_CLASS_MEDIAN.get(kind, POPULATION_CLASS_MEDIAN["unknown"])
    low, high = POPULATION_RANGE
    return {
        "value": int(round(median)),
        "basis": "modelled",
        "basis_note": (
            f"No OSM population tag — planning median for a '{kind}' settlement "
            f"({median:,} persons); range {int(median * low):,}–{int(median * high):,}"
        ),
        "range": {
            "low": int(round(median * low)),
            "mid": int(round(median)),
            "high": int(round(median * high)),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# vulnerability
# ─────────────────────────────────────────────────────────────────────────────

def vulnerability_score(
    *,
    depth_m: float,
    lead_time_min: float | None,
    relative_elevation: float,
    settlement_kind: str,
    population: int,
) -> dict:
    """Vulnerability in [0, 1] from four documented factors.

    Every factor is published with its value and its weight so the UI can show
    a breakdown instead of a mystery multiplier.
    """
    # 1. Exposure intensity: deeper water at the settlement.
    exposure = _band(depth_m, ((0.05, 0.0), (0.3, 0.25), (1.0, 0.55), (2.5, 0.8), (float("inf"), 1.0)), 0.0)

    # 2. Terrain position: how far the settlement sits above the domain's low
    #    ground. Low-lying ground drains slower and floods deeper.
    terrain = float(np.clip(1.0 - relative_elevation, 0.0, 1.0))

    # 3. Warning deficit: little usable lead time = people still in place.
    if lead_time_min is None:
        warning = 0.5  # unknown arrival -> neutral penalty (documented)
    else:
        usable = max(0.0, lead_time_min - MOBILISATION_TIME_MIN)
        warning = float(np.clip(1.0 - usable / 180.0, 0.0, 1.0))

    # 4. Coping capacity: small rural settlements have fewer resources and
    #    lower-quality housing stock than towns/cities.
    capacity = {"hamlet": 0.9, "village": 0.7, "town": 0.45, "city": 0.3}.get(settlement_kind.lower(), 0.6)
    if population >= 100_000:
        capacity = max(0.25, capacity - 0.1)

    weights = {"exposure": 0.40, "terrain": 0.20, "warning": 0.25, "capacity": 0.15}
    score = (
        exposure * weights["exposure"]
        + terrain * weights["terrain"]
        + warning * weights["warning"]
        + capacity * weights["capacity"]
    )
    return {
        "score": round(float(np.clip(score, 0.0, 1.0)), 3),
        "basis": "modelled",
        "factors": [
            {"name": "Exposure intensity", "value": round(exposure, 3), "weight": weights["exposure"],
             "note": f"{depth_m:.2f} m peak depth at the settlement"},
            {"name": "Terrain position", "value": round(terrain, 3), "weight": weights["terrain"],
             "note": "relative elevation above the domain's low ground"},
            {"name": "Warning deficit", "value": round(warning, 3), "weight": weights["warning"],
             "note": ("arrival time unknown — neutral value assumed" if lead_time_min is None
                      else f"{max(0.0, lead_time_min - MOBILISATION_TIME_MIN):.0f} min usable lead time")},
            {"name": "Coping capacity", "value": round(capacity, 3), "weight": weights["capacity"],
             "note": f"settlement class '{settlement_kind}'"},
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# per-settlement estimate
# ─────────────────────────────────────────────────────────────────────────────

def estimate_settlement(
    *,
    settlement: dict,
    depth_grid: Grid,
    arrival_grid: Grid,
    speed_grid: Grid | None,
    elev_grid: Grid | None,
    exposure_pct_grid: Grid | None,
    wet: np.ndarray,
    domain_relief_m: float,
    village_amenities: dict[tuple[int, int], list[dict]],
) -> dict | None:
    """Full impact estimate for one settlement, or None when outside the domain."""
    r, c = depth_grid.index(settlement["lat"], settlement["lon"]) or (None, None)  # type: ignore[misc]
    if r is None or c is None:
        return None

    # ── HAZARD (modelled: engine output sampled over a 3×3 cell footprint) ──
    depth_m = depth_grid.patch_max(r, c, 1)
    speed_ms = speed_grid.patch_max(r, c, 1) if speed_grid is not None else 0.0  # 0.0 is unused when absent
    arrival_min = arrival_grid.patch_min_positive(r, c, 1)
    elev_m = elev_grid.arr[ r, c] if elev_grid is not None else None
    # A settlement standing in the water is zero metres from it; reporting null
    # there would read as "unknown" in the UI when the value is simply 0.
    dist_wet_m = 0.0 if depth_m >= WET_THRESHOLD_M else distance_to_wet_m(depth_grid, r, c, wet)

    if depth_m >= WET_THRESHOLD_M:
        status = "INUNDATED"
    elif dist_wet_m is not None and dist_wet_m <= AT_RISK_RANGE_CELLS * depth_grid.cell_m:
        status = "AT RISK"
    else:
        status = "SAFE"

    likelihood_pct = (
        round(float(exposure_pct_grid.arr[r, c]), 1) if exposure_pct_grid is not None else None
    )
    # No velocity field in the screening engine -> no depth-velocity product.
    # Reported as absent rather than filled with an invented speed.
    index = hazard_index(depth_m, speed_ms) if speed_grid is not None else None

    # ── EXPOSURE ────────────────────────────────────────────────────────────
    pop = resolution_population(settlement)
    pop_value = pop["value"]

    # ── VULNERABILITY ───────────────────────────────────────────────────────
    relative_elevation = (
        float(np.clip((elev_m - (elev_grid.arr.min() if elev_grid is not None else 0.0)) / max(domain_relief_m, 1.0), 0.0, 1.0))
        if elev_m is not None and elev_grid is not None else 0.5
    )
    vuln = vulnerability_score(
        depth_m=depth_m,
        lead_time_min=arrival_min,
        relative_elevation=relative_elevation,
        settlement_kind=str(settlement.get("kind") or "unknown"),
        population=pop_value,
    )

    # ── IMPACT: people ──────────────────────────────────────────────────────
    exposure_fraction = (
        _band(depth_m, POP_EXPOSURE_BY_DEPTH, 0.80)
        if status == "INUNDATED"
        else (AT_RISK_EXPOSURE if status == "AT RISK" else 0.0)
    )
    exposed_mid = pop_value * exposure_fraction
    exposed = _pop_range(exposed_mid)

    depth_factor = _band(depth_m, ((0.05, 0.0), (0.3, 0.2), (1.0, 0.5), (2.5, 0.8), (float("inf"), 1.0)), 0.0)
    if arrival_min is None:
        lead_relief = 0.0
    else:
        lead_relief = float(np.clip((arrival_min - MOBILISATION_TIME_MIN) / 180.0, 0.0, 1.0)) * DISPLACEMENT_LEAD_RELIEF
    displaced_fraction = float(np.clip(
        DISPLACEMENT_BASE + DISPLACEMENT_DEPTH_UPLIFT * depth_factor - lead_relief, 0.0, 0.9))
    displaced = _pop_range(exposed_mid * displaced_fraction)

    # ── EXPOSURE: local critical assets (real OSM inventory when available) ──
    amenity_kinds: list[str] = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            for a in village_amenities.get((r + dr, c + dc), []):
                amenity_kinds.append(str(a.get("kind", "default")))

    # ── ECONOMIC LOSS (modelled: exposure × vulnerability × depth damage) ───
    depth_damage = _band(depth_m, DAMAGE_FACTOR_BY_DEPTH, 0.80)
    urban = str(settlement.get("kind") or "").lower() in ("city", "town", "suburb")
    residential = exposed_mid * UNIT_RESIDENTIAL_PER_PERSON_INR
    commercial = residential * (COMMERCIAL_UPLIFT_URBAN if urban else COMMERCIAL_UPLIFT_RURAL)
    infra = sum(UNIT_INFRASTRUCTURE_INR.get(k, UNIT_INFRASTRUCTURE_INR["default"]) for k in amenity_kinds)
    total_loss_mid = (residential + commercial + infra) * depth_damage
    damage = {
        "total": _money_range(total_loss_mid),
        "residential": _money_range(residential * depth_damage),
        "commercial": _money_range(commercial * depth_damage),
        "infrastructure": _money_range(infra * depth_damage),
        "agriculture": _money_range(0.0),
        "basis": "modelled",
        "basis_note": (
            f"exposed value = {exposed_mid:,.0f} people × ₹{UNIT_RESIDENTIAL_PER_PERSON_INR:,}/person "
            f"(+{int((COMMERCIAL_UPLIFT_URBAN if urban else COMMERCIAL_UPLIFT_RURAL) * 100)}% commercial) "
            f"+ {len(amenity_kinds)} mapped facilities × unit replacement cost; "
            f"× {depth_damage:.2f} depth-damage factor at {depth_m:.2f} m"
        ),
    }

    # ── AVOIDED LOSS (early action) ─────────────────────────────────────────
    avoidance = (_band(max(arrival_min - MOBILISATION_TIME_MIN, 0.0), AVOIDANCE_BY_LEAD_TIME, 0.38)
                 if arrival_min is not None else 0.0)
    movable_saved = (residential + commercial) * depth_damage * avoidance
    fixed_saved = infra * depth_damage * avoidance * FIXED_INFRASTRUCTURE_AVOIDANCE_SHARE
    avoided_mid = movable_saved + fixed_saved
    savings = {
        "avoided": _money_range(avoided_mid),
        "effectiveness": round(float(avoidance), 3),
        "basis": "modelled",
        "basis_note": (
            f"early-action effectiveness {avoidance * 100:.0f}% of movable value at "
            f"{max(0.0, (arrival_min or 0.0) - MOBILISATION_TIME_MIN):.0f} min usable lead time; "
            f"fixed infrastructure credited {FIXED_INFRASTRUCTURE_AVOIDANCE_SHARE * 100:.0f}% of the same curve"
        ),
        "people_protected": _pop_range(exposed_mid * avoidance),
    }

    risk = _risk_from_hazard(index, depth_m, exposed_mid)
    if status == "AT RISK":
        # Sitting against the water's edge is never a "LOW" finding: the
        # settlement could be reached by a modest change in the scenario.
        risk = max(risk, "MODERATE", key=lambda k: _RISK_ORDER[k])
    elif status == "SAFE":
        risk = "LOW"

    return {
        "id": settlement.get("id") or f"{settlement['lat']:.5f},{settlement['lon']:.5f}",
        "name": settlement.get("name", "Unnamed settlement"),
        "kind": settlement.get("kind", "unknown"),
        "lon": round(float(settlement["lon"]), 6),
        "lat": round(float(settlement["lat"]), 6),
        "source": settlement.get("source", "unknown"),
        "status": status,
        "risk": risk,
        "severity_band": severity_band(depth_m),
        "depth_m": round(depth_m, 2),
        "speed_ms": round(speed_ms, 2) if speed_grid is not None else None,
        "hazard_index": None if index is None else round(index, 2),
        "hazard_index_basis": (
            "derived: depth × √(speed²) from the engine velocity field" if index is not None
            else "not available — this engine does not produce a velocity field"
        ),
        "arrival_min": None if arrival_min is None else round(arrival_min, 1),
        "lead_time_min": None if arrival_min is None else round(max(0.0, arrival_min - MOBILISATION_TIME_MIN), 1),
        "distance_to_water_m": None if dist_wet_m is None else round(dist_wet_m),
        "elevation_m": None if elev_m is None else round(float(elev_m), 1),
        "inundation_likelihood_pct": likelihood_pct,
        "population": pop,
        "population_exposed": {
            **exposed,
            "share_of_settlement": round(float(exposure_fraction), 3),
            "basis": "modelled",
            "basis_note": (
                "share of residents inside the modelled inundation footprint "
                f"({exposure_fraction * 100:.0f}% at {depth_m:.2f} m peak depth)"
            ),
        },
        "population_displaced": {
            **displaced,
            "share_of_exposed": round(float(displaced_fraction), 3),
            "basis": "modelled",
            "basis_note": (
                f"displacement rate {displaced_fraction * 100:.0f}% of the exposed population "
                f"({DISPLACEMENT_BASE * 100:.0f}% base, depth uplift, lead-time relief)"
            ),
        },
        "facilities_exposed": sorted(set(amenity_kinds)),
        "vulnerability": vuln,
        "damage": damage,
        "savings": savings,
        "confidence": None,  # filled by the top-level roll-up (shared data quality)
    }


# ─────────────────────────────────────────────────────────────────────────────
# confidence
# ─────────────────────────────────────────────────────────────────────────────

def confidence_assessment(
    *,
    engine: str,
    assets_provenance: str,
    population_basis: str,
    cell_m: float,
    arrival_present: bool,
    ensemble_runs: int,
) -> dict:
    """Data-quality derived confidence (transparent, additive penalties).

    This is a statement about *input quality*, not a probability that the
    flood happens. Wording in the UI must say "confidence in the estimate".
    """
    score = 100.0
    factors: list[dict] = []

    def penalise(key: str, reason: str) -> None:
        nonlocal score
        p = CONFIDENCE_PENALTIES.get(key, 0.0)
        score -= p
        factors.append({"factor": reason, "penalty": p})

    if "lisflood" in engine.lower():
        penalise("engine_hydraulic", "Hydraulic solver (LISFLOOD-FP) — inertial shallow-water routing")
    else:
        penalise("engine_screening", "Screening propagation model (terrain-constrained diffusive), not hydrodynamics")

    if assets_provenance.startswith("osm-live"):
        penalise("assets_osm_live", "Critical-asset inventory: OpenStreetMap, fetched live")
    elif assets_provenance.startswith("osm"):
        penalise("assets_osm_cached", "Critical-asset inventory: OpenStreetMap (cached)")
    else:
        penalise("assets_modelled", "No OSM assets available — documented modelled exposure points in use")

    if population_basis == "observed":
        factors.append({"factor": "Population from OpenStreetMap tags", "penalty": 0.0})
    else:
        penalise("population_modelled", "Population estimated from settlement class (no census join)")

    if cell_m > 60:
        penalise("grid_coarse", f"Coarse simulation cells ({cell_m:.0f} m)")
    elif cell_m > 30:
        penalise("grid_medium", f"Moderate simulation cells ({cell_m:.0f} m)")
    else:
        penalise("grid_fine", f"Fine simulation cells ({cell_m:.0f} m)")

    if not arrival_present:
        penalise("arrival_missing", "No arrival time resolved at the settlement")

    if ensemble_runs >= 5:
        score += CONFIDENCE_ENSEMBLE_BONUS
        factors.append({"factor": f"{ensemble_runs} scenario runs aggregated (probability from spread)", "penalty": -CONFIDENCE_ENSEMBLE_BONUS})

    score = float(np.clip(score, 5.0, 100.0))
    level = "High" if score >= CONFIDENCE_HIGH_MIN else "Medium" if score >= CONFIDENCE_MEDIUM_MIN else "Low"
    return {
        "level": level,
        "score": round(score, 1),
        "basis": "modelled",
        "basis_note": "Additive input-quality score: 100 minus the penalties below",
        "factors": factors,
    }


# ─────────────────────────────────────────────────────────────────────────────
# drivers ("why did the model say this?")
# ─────────────────────────────────────────────────────────────────────────────

def explain_drivers(
    *,
    scenario: dict,
    peak_depth_m: float,
    earliest_arrival_min: float | None,
    settlements_exposed: int,
    flooded_area_km2: float,
    critical_assets: int,
) -> list[dict]:
    """Ranked, human-readable drivers of the headline result."""
    out: list[dict] = []

    rainfall_raw = scenario.get("rainfall_factor")
    release = float(scenario.get("initial_release_m3") or 0.0)
    width = float(scenario.get("breach_width_m") or 0.0)

    out.append({
        "factor": "Breach release volume",
        "value": f"{release / 1e6:,.0f} MCM",
        "direction": "up",
        "note": f"scenario '{scenario.get('label', 'custom')}' breach width {width:.0f} m — the dominant driver of downstream extent",
    })
    if rainfall_raw is None:
        out.append({
            "factor": "Rainfall loading",
            "value": "not applied",
            "direction": "down",
            "note": "this run is breach-only (no rainfall forcing was supplied to the solver)",
        })
    else:
        rainfall = float(rainfall_raw)
        out.append({
            "factor": "Rainfall loading",
            "value": f"×{rainfall:g} design storm",
            "direction": "up" if rainfall > 1.0 else "down",
            "note": "multiplier on the 20 mm/h design storm used by the model",
        })
    if peak_depth_m > 0:
        out.append({
            "factor": "Peak modelled depth",
            "value": f"{peak_depth_m:.2f} m",
            "direction": "up" if peak_depth_m >= 1.0 else "down",
            "note": "deepest water anywhere outside the breach source zone",
        })
    if earliest_arrival_min is not None:
        out.append({
            "factor": "Time to first impact",
            "value": f"T+{earliest_arrival_min:.0f} min",
            "direction": "up" if earliest_arrival_min <= 60 else "down",
            "note": "earliest modelled arrival at a mapped settlement or asset",
        })
    out.append({
        "factor": "Exposed settlements & facilities",
        "value": f"{settlements_exposed} settlements, {critical_assets} critical assets",
        "direction": "up" if (settlements_exposed + critical_assets) else "down",
        "note": f"within {flooded_area_km2:.2f} km² modelled inundation footprint",
    })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# decision-support scoring (deterministic, explainable)
# ─────────────────────────────────────────────────────────────────────────────

# Population-at-Risk priority: component weights (sum to 100). Every component
# cites the value it scored, so the UI can show WHY a place got its band.
PRIORITY_WEIGHTS = {
    "population": 40,   # exposed population (log scale, saturates at 50k)
    "depth": 20,        # modelled water depth at the settlement
    "arrival": 20,      # modelled arrival time (sooner = more urgent)
    "connectivity": 10, # evacuation accessibility (no usable road = worse)
    "assets": 10,       # critical facilities exposed at/near the settlement
}
PRIORITY_BANDS = ((30.0, "MEDIUM"), (50.0, "HIGH"), (70.0, "CRITICAL"))  # else LOW


def _pop_component(exposed_mid: float) -> tuple[float, str]:
    w = PRIORITY_WEIGHTS["population"]
    score = w * math.log10(1.0 + max(exposed_mid, 0.0)) / math.log10(1.0 + 50_000)
    score = float(np.clip(score, 0.0, w))
    return round(score, 1), f"{exposed_mid:,.0f} people potentially exposed"


def _depth_component(depth_m: float) -> tuple[float, str]:
    w = PRIORITY_WEIGHTS["depth"]
    if depth_m < WET_THRESHOLD_M:
        return 0.0, "no modelled water at the settlement"
    if depth_m < 0.3:
        return round(w * 0.25, 1), f"nuisance depth {depth_m:.2f} m"
    if depth_m < 1.0:
        return round(w * 0.5, 1), f"depth {depth_m:.2f} m (low band)"
    if depth_m < 2.5:
        return round(w * 0.75, 1), f"depth {depth_m:.2f} m (moderate band)"
    return w, f"depth {depth_m:.2f} m (high band)"


def _arrival_component(arrival_min: float | None) -> tuple[float, str]:
    w = PRIORITY_WEIGHTS["arrival"]
    if arrival_min is None:
        return round(w * 0.2, 1), "arrival time not resolved by the model"
    if arrival_min <= 15:
        return w, f"water arrives T+{arrival_min:.0f} min (≤15 min)"
    if arrival_min <= 30:
        return round(w * 0.8, 1), f"water arrives T+{arrival_min:.0f} min"
    if arrival_min <= 60:
        return round(w * 0.6, 1), f"water arrives T+{arrival_min:.0f} min"
    if arrival_min <= 120:
        return round(w * 0.4, 1), f"water arrives T+{arrival_min:.0f} min"
    return round(w * 0.25, 1), f"water arrives T+{arrival_min:.0f} min (>2 h)"


def _connectivity_component(connectivity: dict | None) -> tuple[float, str]:
    w = PRIORITY_WEIGHTS["connectivity"]
    if not connectivity:
        # Neutral mid-score when the evacuation layer did not run — never a
        # silent penalty for data the model does not have.
        return round(w * 0.5, 1), "evacuation connectivity not assessed"
    km = connectivity.get("nearest_usable_road_km")
    if km is None:
        return w, "no usable evacuation road found in the mapped road data"
    if km <= 2.0:
        return round(w * 0.1, 1), f"usable evacuation road {km:.1f} km away"
    if km <= 5.0:
        return round(w * 0.4, 1), f"nearest usable evacuation road {km:.1f} km away"
    return round(w * 0.8, 1), f"nearest usable evacuation road {km:.1f} km away (poor access)"


def _asset_component(facilities: list[str]) -> tuple[float, str]:
    w = PRIORITY_WEIGHTS["assets"]
    n = len(facilities)
    if n == 0:
        return 0.0, "no critical facilities in the flooded footprint here"
    if n == 1:
        return round(w * 0.4, 1), f"1 critical facility exposed ({facilities[0].replace('_', ' ')})"
    if n <= 3:
        return round(w * 0.7, 1), f"{n} critical facilities exposed"
    return w, f"{n} critical facilities exposed"


def priority_score(
    *,
    settlement_row: dict,
    connectivity: dict | None = None,
) -> dict:
    """Population-at-Risk priority (0–100 → LOW/MEDIUM/HIGH/CRITICAL) + reasons.

    Deterministic and explainable: the same inputs always produce the same
    band, and every component records the value it scored. This is a
    prioritization aid for response planning — NOT a casualty prediction.
    """
    status = settlement_row["status"]
    if status == "SAFE":
        return {
            "score": 0, "band": "LOW", "basis": "modelled",
            "reasons": ["no modelled water at or near this settlement in this scenario"],
        }
    comps = [
        _pop_component(settlement_row["population_exposed"]["mid"]),
        _depth_component(settlement_row["depth_m"]),
        _arrival_component(settlement_row["arrival_min"]),
        _connectivity_component(connectivity),
        _asset_component(settlement_row.get("facilities_exposed", [])),
    ]
    score = round(sum(s for s, _ in comps), 1)
    band = "LOW"
    for threshold, b in PRIORITY_BANDS:
        if score >= threshold:
            band = b
    return {
        "score": score,
        "band": band,
        "basis": "modelled",
        "reasons": [text for _, text in comps],
    }


def _asset_flood_risk(depth_m: float, arrival_min: float | None) -> str:
    """Display band for an exposed asset (mirrors settlement depth bands)."""
    if depth_m < WET_THRESHOLD_M:
        return "LOW"
    if depth_m >= 2.5:
        return "EXTREME"
    if depth_m >= 1.0:
        return "HIGH"
    if depth_m >= 0.3:
        return "MODERATE"
    return "LOW"


def asset_exposure_rows(
    *,
    asset_list: list[dict],
    depth_grid: "Grid",
    arrival_grid: "Grid",
    dam: dict,
) -> list[dict]:
    """Per-asset exposure records for every mapped critical facility.

    Distance is the over-ground distance from the dam (derived), depth/arrival
    are engine samples (modelled). Assets the model does not reach are listed
    as DRY — absence of water in the model is information too.
    """
    dam_lat, dam_lon = dam.get("lat"), dam.get("lon")
    rows: list[dict] = []
    for a in asset_list:
        kind = str(a.get("kind") or "")
        if kind not in {"hospital", "school", "substation", "plant", "power",
                        "police_station", "telecom_tower", "bridge"}:
            continue
        lat, lon = a.get("lat"), a.get("lon")
        if lat is None or lon is None:
            continue
        idx = depth_grid.index(float(lat), float(lon))
        if idx is None:
            continue
        r, c = idx
        depth_m = depth_grid.patch_max(r, c, 1)
        arrival_min = arrival_grid.patch_min_positive(r, c, 1)
        distance_km = None
        if dam_lat is not None and dam_lon is not None:
            distance_km = round(overground_distance_m(float(dam_lon), float(dam_lat), float(lon), float(lat)) / 1000.0, 2)
        if depth_m < WET_THRESHOLD_M:
            band, reasons = "LOW", ["no modelled water reaches this asset in this scenario"]
        else:
            band = _asset_flood_risk(depth_m, arrival_min)
            reasons = [f"modelled depth {depth_m:.2f} m at the asset footprint"]
            if arrival_min is not None:
                reasons.append(f"water arrives T+{arrival_min:.0f} min")
            if distance_km is not None:
                reasons.append(f"{distance_km:.1f} km downstream of the dam")
        order = {"LOW": 0, "MODERATE": 1, "HIGH": 2, "EXTREME": 3}
        rows.append({
            "id": a.get("id") or f"asset-{lon:.5f},{lat:.5f}",
            "name": a.get("name", "Unnamed facility"),
            "kind": kind,
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "source": a.get("source", "unknown"),
            "distance_km": distance_km,
            "arrival_min": None if arrival_min is None else round(arrival_min, 1),
            "depth_m": round(depth_m, 2),
            "flood_risk": band,
            "priority": band,
            "status": "EXPOSED" if depth_m >= WET_THRESHOLD_M else "DRY",
            "reasons": reasons,
            "_order": order[band],
        })
    rows.sort(key=lambda x: (-x["_order"], x["arrival_min"] if x["arrival_min"] is not None else 1e9))
    for r in rows:
        r.pop("_order", None)
    return rows


def decision_summary(
    *,
    settlements: list[dict],
    assets: list[dict],
    totals: dict,
    scenario_label: str,
    evacuation: dict | None = None,
) -> dict:
    """WHERE / WHEN / WHO / WHY — the concise decision-support narrative.

    Pure text assembly over computed values: every sentence cites a number
    that already exists in the payload. No new figures are invented here.
    """
    def _name(r: dict) -> str:
        return r["name"]

    risky = [s for s in settlements if s["status"] != "SAFE"]
    risky.sort(key=lambda s: (-(s["population_exposed"]["mid"]), s["arrival_min"] if s["arrival_min"] is not None else 1e9))
    first_arrivals = sorted([s for s in settlements if s["arrival_min"] is not None],
                            key=lambda s: s["arrival_min"])[:3]
    critical = [s for s in settlements if s.get("priority", {}).get("band") in ("HIGH", "CRITICAL")][:3]
    exposed_assets = [a for a in assets if a["status"] == "EXPOSED"]

    where = [
        f"{totals['settlements_inundated']} settlement(s) stand in the modelled water and "
        f"{totals['settlements_at_risk']} more at its edge — {totals['flooded_area_km2']:.2f} km² inundated "
        f"(scenario '{scenario_label}', peak depth {totals['peak_depth_m']:.1f} m).",
    ]
    if risky:
        where.append("Most exposed: " + ", ".join(
            f"{_name(s)} ({s['population_exposed']['mid']:,.0f} people)" for s in risky[:3]) + ".")
    if exposed_assets:
        kinds = sorted({a["kind"].replace("_", " ") for a in exposed_assets})
        where.append(f"{len(exposed_assets)} critical asset(s) in the footprint, including {', '.join(kinds[:4])}.")

    when = []
    if first_arrivals:
        when.append("First water reaches " + ", ".join(
            f"{_name(s)} at T+{s['arrival_min']:.0f} min" for s in first_arrivals) +
            " (modelled arrival times, not forecasts).")
    elif totals.get("earliest_arrival_min") is not None:
        when.append(f"Earliest modelled arrival anywhere: T+{totals['earliest_arrival_min']:.0f} min.")
    else:
        when.append("Arrival times were not resolved for any mapped location in this run.")

    who = []
    if critical:
        who.append("Prioritize: " + "; ".join(
            f"{_name(s)} — {s['priority']['band']} ({s['priority']['score']:.0f}/100)" for s in critical) + ".")
    elif risky:
        who.append("Prioritize by exposed population: " + ", ".join(
            _name(s) for s in risky[:2]) + ".")
    else:
        who.append("No mapped settlement requires priority action in this scenario.")
    if evacuation and evacuation.get("corridors"):
        ok = [c for c in evacuation["corridors"] if c.get("status") == "RECOMMENDED CANDIDATE"]
        if ok:
            who.append(f"{len(ok)} candidate evacuation corridor(s) identified — see the Evacuation section; "
                       "candidates are leads to verify on the ground, not guarantees.")

    why = [
        f"Overall risk band '{totals['overall_risk']}' comes from the worst settlement-level finding: "
        "depth bands escalated by exposed population (documented thresholds, no fitted model).",
        "Depths/arrival are a terrain-constrained screening propagation — compare cases, do not treat as predictions.",
    ]
    if any(s.get("priority", {}).get("band") == "CRITICAL" for s in settlements):
        why.append("A CRITICAL priority means high exposure AND short arrival AND constrained evacuation connectivity — all three scored.")

    return {
        "where": where,
        "when": when,
        "who": who,
        "why": why,
        "basis": "modelled",
        "note": "Every statement cites computed values from this assessment; nothing here is an independent prediction.",
    }


# ─────────────────────────────────────────────────────────────────────────────
# top-level pipeline
# ─────────────────────────────────────────────────────────────────────────────

def _assumptions(population_modelled: bool) -> list[dict]:
    """Every tunable parameter, with its unit, value and rationale."""
    return [
        {"stage": "hazard", "parameter": "Inundation threshold", "value": f"{WET_THRESHOLD_M} m",
         "basis": "assumed", "note": "cells shallower than this are treated as not inundated"},
        {"stage": "exposure", "parameter": "Population source",
         "value": "OSM tag where present, else settlement-class median",
         "basis": "observed" if not population_modelled else "assumed",
         "note": "city 150k / town 12k / village 1.2k / hamlet 180 persons, range ±50/60%"},
        {"stage": "impact", "parameter": "Population inside the flood footprint",
         "value": "15% / 35% / 60% / 80% by depth band",
         "basis": "assumed", "note": "share of residents in the wet area at <0.3 / <1 / <2.5 / ≥2.5 m"},
        {"stage": "impact", "parameter": "Displacement rate",
         "value": f"{DISPLACEMENT_BASE:.0%} base + depth uplift − lead-time relief",
         "basis": "assumed", "note": "share of the exposed population needing temporary relocation"},
        {"stage": "loss", "parameter": "Residential exposure",
         "value": f"₹{UNIT_RESIDENTIAL_PER_PERSON_INR:,}/person",
         "basis": "assumed", "note": "household structure + movable assets, planning level"},
        {"stage": "loss", "parameter": "Commercial uplift",
         "value": f"+{COMMERCIAL_UPLIFT_URBAN:.0%} urban / +{COMMERCIAL_UPLIFT_RURAL:.0%} rural",
         "basis": "assumed", "note": "extra commercial/industrial value over residential"},
        {"stage": "loss", "parameter": "Facility replacement costs",
         "value": "₹8 Cr bridge · ₹25 Cr hospital · ₹3 Cr school · ₹5 Cr substation · ₹8 L telecom",
         "basis": "assumed", "note": "per mapped facility, planning-level replacement value"},
        {"stage": "loss", "parameter": "Depth-damage factor",
         "value": "15% / 35% / 60% / 80% by depth band",
         "basis": "assumed", "note": "share of exposed value lost at peak depth"},
        {"stage": "loss", "parameter": "Agriculture",
         "value": f"₹{CROP_VALUE_PER_HA_INR:,}/ha × {AGRICULTURAL_SHARE_OF_FLOODED_AREA:.0%} of the flooded footprint",
         "basis": "assumed", "note": "rain-fed crop value per season; drainable area removed by the engine"},
        {"stage": "loss", "parameter": "Uncertainty band",
         "value": f"±{MONEY_SPREAD:.0%} (money), ±{POPULATION_SPREAD:.0%} (population)",
         "basis": "assumed", "note": "spread applied to every modelled total shown as a range"},
        {"stage": "savings", "parameter": "Early-action effectiveness",
         "value": "0 / 10 / 18 / 26 / 32 / 38 % at 0 / 30 / 60 / 180 / 360 / 360+ min lead",
         "basis": "assumed", "note": "share of movable value saved by warning, evacuation and asset protection"},
        {"stage": "savings", "parameter": "Fixed infrastructure avoidance",
         "value": f"{FIXED_INFRASTRUCTURE_AVOIDANCE_SHARE:.0%} of the movable curve",
         "basis": "assumed", "note": "bridges, substations and buildings are largely not protectable in minutes"},
        {"stage": "savings", "parameter": "Mobilisation time",
         "value": f"{MOBILISATION_TIME_MIN:.0f} min",
         "basis": "assumed", "note": "alert issue → people actually moving; subtracted from arrival time"},
        {"stage": "priority", "parameter": "Priority weights",
         "value": "population 40 · depth 20 · arrival 20 · evacuation access 10 · facilities 10",
         "basis": "assumed", "note": "0–100 score banded LOW <30 / MEDIUM <50 / HIGH <70 / CRITICAL ≥70; deterministic, never a casualty estimate"},
        {"stage": "priority", "parameter": "Evacuation travel speed",
         "value": f"{EVAC_SPEED_KMH:.0f} km/h on major roads",
         "basis": "assumed", "note": "used only for candidate-route travel-time estimates"},
    ]


def estimate_impact(
    *,
    depth_m: np.ndarray,
    arrival_min: np.ndarray,
    bbox: Sequence[float],
    cell_m: float,
    dam: dict,
    settlements: Iterable[dict],
    engine: str,
    assets_provenance: str,
    scenario: dict,
    speed_ms: np.ndarray | None = None,
    elevation_m: np.ndarray | None = None,
    exposure_pct: np.ndarray | None = None,
    assets: Sequence[dict] | None = None,
    evacuation: dict | None = None,
    evacuation_provider=None,
    ensemble_runs: int = 0,
    agricultural_share: float = AGRICULTURAL_SHARE_OF_FLOODED_AREA,
    max_settlements: int = 250,
) -> dict:
    """Run the full HAZARD→…→AVOIDED-LOSS chain over a simulation result.

    Returns a self-describing payload: headline totals, per-settlement detail,
    confidence, drivers, assumptions and the formula list, so every number the
    UI displays can be traced back to its source and to the assumption behind it.
    """
    depth_grid = Grid(np.asarray(depth_m, dtype=np.float64), cell_m, bbox)
    arrival_grid = Grid(np.asarray(arrival_min, dtype=np.float64), cell_m, bbox)
    speed_grid = Grid(np.asarray(speed_ms, dtype=np.float64), cell_m, bbox) if speed_ms is not None else None
    elev_grid = Grid(np.asarray(elevation_m, dtype=np.float64), cell_m, bbox) if elevation_m is not None else None
    pct_grid = Grid(np.asarray(exposure_pct, dtype=np.float32), cell_m, bbox) if exposure_pct is not None else None

    wet = depth_grid.arr >= WET_THRESHOLD_M
    flooded_area_km2 = float(wet.sum() * cell_m ** 2 / 1e6)
    domain_relief_m = float(np.ptp(elev_grid.arr)) if elev_grid is not None else 50.0

    asset_list = list(assets or [])
    # Group mapped facilities by grid cell so settlements can pick up the
    # critical assets sitting inside their 3×3 footprint.
    village_amenities: dict[tuple[int, int], list[dict]] = {}
    critical_kinds = {"hospital", "school", "substation", "plant", "power", "police_station",
                      "telecom_tower", "bridge"}
    critical_assets_hit = 0
    for a in asset_list:
        if a.get("kind") not in critical_kinds:
            continue
        idx = depth_grid.index(float(a.get("lat", 0.0)), float(a.get("lon", 0.0)))
        if idx is None:
            continue
        ar, ac = idx
        # Facility counts as exposed when water reaches its cell footprint.
        d = depth_grid.patch_max(ar, ac, 1)
        if d >= WET_THRESHOLD_M:
            critical_assets_hit += 1
            village_amenities.setdefault((ar, ac), []).append(a)

    # ── per-settlement estimates ────────────────────────────────────────────
    rows: list[dict] = []
    for s in list(settlements)[:max_settlements]:
        if s.get("lat") is None or s.get("lon") is None:
            continue
        row = estimate_settlement(
            settlement=s,
            depth_grid=depth_grid,
            arrival_grid=arrival_grid,
            speed_grid=speed_grid,
            elev_grid=elev_grid,
            exposure_pct_grid=pct_grid,
            wet=wet,
            domain_relief_m=domain_relief_m,
            village_amenities=village_amenities,
        )
        if row is not None:
            rows.append(row)

    # Rank: exposed population first, then severity, then earliest arrival.
    rows.sort(key=lambda x: (
        -x["population_exposed"]["mid"],
        -x["depth_m"],
        x["arrival_min"] if x["arrival_min"] is not None else 1e9,
    ))

    # ── Population-at-Risk priority (explainable, deterministic) ────────────
    # The evacuation layer runs between the two priority passes: it needs the
    # settlement statuses computed above, and the connectivity component needs
    # its corridor results. If the provider fails or road data is unavailable
    # the component stays neutral instead of penalizing missing data.
    if evacuation is None and callable(evacuation_provider):
        try:
            evacuation = evacuation_provider(rows)
        except Exception as e:  # defensive: evacuation must never sink the estimate
            print(f"[impact] evacuation layer failed: {e}")
            evacuation = {
                "data_source": "unavailable",
                "corridors": [], "unsafe_roads": [], "unsafe_road_paths": [],
                "bottlenecks": [],
                "safe_zone": {"sectors": [], "note": "not computed"},
                "note": f"Evacuation analysis failed and was skipped: {e}",
            }
    conn_by_id: dict[str, dict] = {}
    if evacuation:
        for corr in evacuation.get("corridors", []):
            sid = corr.get("settlement_id")
            if sid:
                conn_by_id[sid] = {
                    "nearest_usable_road_km": corr.get("usable_road_distance_km"),
                }
    for r in rows:
        r["priority"] = priority_score(settlement_row=r, connectivity=conn_by_id.get(r["id"]))
    priority_counts = {"LOW": 0, "MEDIUM": 0, "HIGH": 0, "CRITICAL": 0}
    for r in rows:
        b = r["priority"]["band"]
        if b in priority_counts:
            priority_counts[b] += 1

    # ── Asset exposure records (every mapped critical facility) ─────────────
    assets_out = asset_exposure_rows(
        asset_list=asset_list, depth_grid=depth_grid, arrival_grid=arrival_grid, dam=dam,
    )

    population_modelled = any(r["population"]["basis"] == "modelled" for r in rows)
    arrival_any = any(r["arrival_min"] is not None for r in rows)
    confidence = confidence_assessment(
        engine=engine,
        assets_provenance=assets_provenance,
        population_basis="modelled" if population_modelled else "observed",
        cell_m=float(cell_m),
        arrival_present=arrival_any,
        ensemble_runs=ensemble_runs,
    )
    for r in rows:
        r["confidence"] = confidence["level"]

    # ── totals ──────────────────────────────────────────────────────────────
    exposed_mid = sum(r["population_exposed"]["mid"] for r in rows)
    exposed_low = sum(r["population_exposed"]["low"] for r in rows)
    exposed_high = sum(r["population_exposed"]["high"] for r in rows)
    displaced_mid = sum(r["population_displaced"]["mid"] for r in rows)
    displaced_low = sum(r["population_displaced"]["low"] for r in rows)
    displaced_high = sum(r["population_displaced"]["high"] for r in rows)

    total_damage_mid = sum(r["damage"]["total"]["mid_inr"] for r in rows)
    total_damage_low = sum(r["damage"]["total"]["low_inr"] for r in rows)
    total_damage_high = sum(r["damage"]["total"]["high_inr"] for r in rows)

    # Agriculture: cropland share of the flooded footprint *outside* the
    # mapped settlement footprints (settlement land is already counted above).
    agro_km2 = flooded_area_km2 * agricultural_share
    agro_mid = agro_km2 * 100.0 * CROP_VALUE_PER_HA_INR
    agro_damage = _money_range(agro_mid)
    agriculture = {
        **agro_damage,
        "basis": "modelled",
        "basis_note": (
            f"{agro_km2:.3f} km² of the modelled inundation footprint × "
            f"{agricultural_share:.0%} assumed cropland/pasture share × ₹{CROP_VALUE_PER_HA_INR:,}/ha"
        ),
        "area_km2": round(agro_km2, 3),
    }
    total_damage_mid += agro_damage["mid_inr"]
    total_damage_low += agro_damage["low_inr"]
    total_damage_high += agro_damage["high_inr"]

    avoided_mid = sum(r["savings"]["avoided"]["mid_inr"] for r in rows)
    avoided_low = sum(r["savings"]["avoided"]["low_inr"] for r in rows)
    avoided_high = sum(r["savings"]["avoided"]["high_inr"] for r in rows)
    agro_avoided = agro_mid * _band(
        max((r["lead_time_min"] or 0.0) for r in rows) if rows else 0.0,
        AVOIDANCE_BY_LEAD_TIME, 0.0)
    avoided_mid += agro_avoided
    avoided_low += agro_avoided * (1 - MONEY_SPREAD)
    avoided_high += agro_avoided * (1 + MONEY_SPREAD)

    people_protected_mid = sum(r["savings"]["people_protected"]["mid"] for r in rows)
    residual_mid = max(0.0, total_damage_mid - avoided_mid)

    inundated = [r for r in rows if r["status"] == "INUNDATED"]
    at_risk = [r for r in rows if r["status"] == "AT RISK"]
    critical_settlements = [r for r in rows if r["risk"] in ("HIGH", "EXTREME")]
    peak_depth = float(depth_grid.arr.max(initial=0.0)) if depth_grid.arr.size else 0.0
    earliest_arrival = min((r["arrival_min"] for r in rows if r["arrival_min"] is not None), default=None)

    overall_risk = max((r["risk"] for r in rows), key=lambda x: _RISK_ORDER[x], default="LOW")

    drivers = explain_drivers(
        scenario=scenario,
        peak_depth_m=peak_depth,
        earliest_arrival_min=earliest_arrival,
        settlements_exposed=len(inundated) + len(at_risk),
        flooded_area_km2=flooded_area_km2,
        critical_assets=critical_assets_hit,
    )

    decision = decision_summary(
        settlements=rows,
        assets=assets_out,
        totals={
            "overall_risk": overall_risk,
            "flooded_area_km2": flooded_area_km2,
            "settlements_inundated": len(inundated),
            "settlements_at_risk": len(at_risk),
            "peak_depth_m": peak_depth,
            "earliest_arrival_min": earliest_arrival,
        },
        scenario_label=str(scenario.get("label", "custom")),
        evacuation=evacuation,
    )

    return {
        "pipeline": ["hazard", "exposure", "vulnerability", "impact", "economic_loss", "avoided_loss"],
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dam": {"name": dam.get("name", "dam"), "lat": dam.get("lat"), "lon": dam.get("lon"),
                "bbox_wsen": [round(float(v), 6) for v in bbox]},
        "evidence_legend": {
            "observed": "Read from a data source (OpenStreetMap tags, DEM samples, engine grids)",
            "derived": "Arithmetic on observed values (areas, distances, sums)",
            "modelled": "Produced by a documented model — a simulation, not the real river",
            "assumed": "A chosen planning parameter, listed under `assumptions`",
        },
        "engine": {"name": engine, "cell_m": round(float(cell_m), 2),
                   "note": "Simulation output is MODELLED, never observed"},
        "scenario": scenario,
        "totals": {
            "overall_risk": overall_risk,
            "flooded_area_km2": round(flooded_area_km2, 4),
            "settlements_assessed": len(rows),
            "settlements_inundated": len(inundated),
            "settlements_at_risk": len(at_risk),
            "settlements_high_or_extreme": len(critical_settlements),
            "critical_assets_exposed": critical_assets_hit,
            "priority_counts": priority_counts,
            "population_exposed": {"low": exposed_low, "mid": exposed_mid, "high": exposed_high,
                                   "basis": "modelled",
                                   "basis_note": "sum of per-settlement exposure (spread already applied)"},
            "population_displaced": {"low": displaced_low, "mid": displaced_mid, "high": displaced_high,
                                     "basis": "modelled"},
            "people_protected": _pop_range(people_protected_mid),
            "damage": {
                "low_inr": total_damage_low, "mid_inr": total_damage_mid, "high_inr": total_damage_high,
                "basis": "modelled",
                "basis_note": "sum of per-settlement loss + assumed agricultural share of the footprint",
            },
            "damage_breakdown": {
                "residential_inr": int(round(sum(r["damage"]["residential"]["mid_inr"] for r in rows))),
                "commercial_inr": int(round(sum(r["damage"]["commercial"]["mid_inr"] for r in rows))),
                "infrastructure_inr": int(round(sum(r["damage"]["infrastructure"]["mid_inr"] for r in rows))),
                "agriculture_inr": agriculture["mid_inr"],
            },
            "avoided": {
                "low_inr": int(round(avoided_low)), "mid_inr": int(round(avoided_mid)),
                "high_inr": int(round(avoided_high)),
                "basis": "modelled",
                "basis_note": "estimated potential saving — early action reduces, never eliminates, damage",
            },
            "residual_damage": _money_range(residual_mid),
            "agriculture": agriculture,
            "peak_depth_m": round(peak_depth, 2),
            "earliest_arrival_min": None if earliest_arrival is None else round(earliest_arrival, 1),
        },
        "confidence": confidence,
        "drivers": drivers,
        "assets": assets_out,
        "evacuation": evacuation if evacuation is not None else {
            "data_source": "not_computed", "corridors": [], "unsafe_roads": [],
            "note": "Evacuation analysis was not part of this run.",
        },
        "decision": decision,
        "settlements": rows,
        "assumptions": _assumptions(population_modelled),
        "method": [
            {"stage": "hazard", "formula": "depth, arrival, speed = engine grid sampled over the settlement's 3×3 cell footprint",
             "class": "modelled"},
            {"stage": "hazard", "formula": "hazard_index = depth (m) × √(speed (m/s)²)", "class": "derived"},
            {"stage": "exposure", "formula": "population = OSM tag, else settlement-class median", "class": "observed|assumed"},
            {"stage": "exposure", "formula": "population_exposed = population × footprint share(depth)", "class": "modelled"},
            {"stage": "vulnerability", "formula": "V = 0.40·exposure + 0.20·terrain + 0.25·warning deficit + 0.15·coping capacity",
             "class": "modelled"},
            {"stage": "impact", "formula": "displaced = exposed × (0.35 + 0.25·depth factor − lead-time relief)", "class": "modelled"},
            {"stage": "economic_loss",
             "formula": "damage = (exposed × ₹250k + commercial uplift + mapped facility values) × depth-damage factor",
             "class": "modelled"},
            {"stage": "economic_loss", "formula": "agriculture = flooded area × cropland share × ₹65k/ha", "class": "modelled"},
            {"stage": "avoided_loss",
             "formula": "avoided = movable damage × effectiveness(lead time) + fixed damage × 0.15 × effectiveness",
             "class": "modelled"},
            {"stage": "confidence", "formula": "score = 100 − Σ(input-quality penalties) + ensemble bonus", "class": "modelled"},
        ],
        "limits": [
            "Every depth, arrival and speed value is SIMULATED, not observed.",
            "Damage and savings use planning-level unit rates, not surveyed values.",
            "Population is only as good as the OpenStreetMap tag coverage for the area.",
            "No single number here is a forecast of a specific event.",
        ],
    }
