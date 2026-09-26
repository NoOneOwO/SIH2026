"""
DamSafe Twin — evacuation route screening layer.

WHAT THIS IS
------------
A deterministic, explainable MVP analysis that answers: "if the modelled flood
happens, which major roads stay usable, which are cut, and which corridors
could plausibly serve as evacuation routes?"

WHAT THIS IS NOT
----------------
Not a routing engine and not a safety certification. Corridors are CANDIDATES
for ground verification — the UI must keep that label visible.

METHOD (all steps documented, deterministic, no fitted model)
-------------------------------------------------------------
1. Fetch major roads (motorway/trunk/primary/secondary/tertiary) + bridges
   around the dam from OpenStreetMap via Overpass (cached 30 days, same
   policy as the asset inventory).
2. Sample the modelled depth/arrival grids along each road polyline.
3. Classify each road: FLOODED (≥ 0.5 m somewhere), RESTRICTED (≥ 0.15 m),
   or USABLE within the modelled domain. Roads outside the grid are marked
   outside-domain, not silently called safe.
4. Per exposed settlement: the nearest USABLE major road becomes a candidate
   evacuation corridor, with distance, travel time (documented speed
   assumption) and the safe bearing away from the dam.
5. Safe-zone direction: bearing sectors from the dam with no modelled water.
6. Bottlenecks: bridges classified FLOODED — single-point failures in the
   road network.

FALLBACK: if Overpass is unreachable, returns `data_source: "unavailable"`
with empty lists and an honest note. Nothing downstream breaks and nothing
is fabricated.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import requests

from app.impact.estimation import EVAC_SPEED_KMH, WET_THRESHOLD_M
from app.impact.grids import overground_distance_m

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
CACHE_DIR = Path(os.environ.get("DAMSAFE_ASSETS_CACHE", str(BACKEND_DIR / "app" / "sandbox" / "assets_cache")))
OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
CACHE_TTL_DAYS = 30

# Overpass rejects default library User-Agents (406); identify the app.
HTTP_HEADERS = {"User-Agent": "AquaShield3D/1.0 (dam-break decision-support prototype; contact: dev@damsafe.local)"}

# Depth at which a major road is treated as impassable for most vehicles
# (screening threshold; deeper water also hides road damage).
FLOODED_ROAD_DEPTH_M = 0.50
RESTRICTED_ROAD_DEPTH_M = 0.15

MAJOR_HIGHWAY = "motorway|trunk|primary|secondary|tertiary"

ROAD_STATUS_ORDER = {"USABLE": 0, "RESTRICTED": 1, "FLOODED": 2}


def _cache_path(dam_id: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{dam_id}.roads.json"


def _fresh(path: Path) -> bool:
    try:
        return (time.time() - path.stat().st_mtime) / 86400 < CACHE_TTL_DAYS
    except OSError:
        return False


def fetch_roads(lat: float, lon: float, radius_m: float = 12000) -> list[dict] | None:
    """Major roads + bridges around (lat, lon) from Overpass, or None on failure.

    Each road: {id, name, kind, is_bridge, coords: [(lat, lon), ...]}.
    `out geom` returns way geometry inline; no node resolution needed.
    """
    query = f"""
    [out:json][timeout:60];
    (
      way["highway"~"^({MAJOR_HIGHWAY})$"](around:{int(radius_m)},{lat},{lon});
      way["bridge"="yes"]["highway"](around:{int(radius_m)},{lat},{lon});
    );
    out geom 400;
    """.strip()
    r = requests.post(OVERPASS_URL, data={"data": query}, timeout=70, headers=HTTP_HEADERS)
    r.raise_for_status()
    data = r.json()
    roads: list[dict] = []
    seen: set[int] = set()
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        wid = el.get("id")
        if wid in seen:
            continue
        seen.add(wid)
        geom = el.get("geometry") or []
        coords = [(g.get("lat"), g.get("lon")) for g in geom if g.get("lat") is not None and g.get("lon") is not None]
        if len(coords) < 2:
            continue
        tags = el.get("tags", {})
        roads.append({
            "id": str(wid),
            "name": tags.get("name") or tags.get("ref") or f"Unnamed {tags.get('highway', 'road')}",
            "kind": tags.get("highway", "road"),
            "is_bridge": tags.get("bridge") == "yes",
            "coords": coords,
        })
    return roads


def _load_roads(dam_id: str, lat: float, lon: float) -> tuple[list[dict] | None, str]:
    """(roads, provenance). Cached copy preferred; None only when unavailable."""
    cache = _cache_path(dam_id)
    if cache.exists() and _fresh(cache):
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if cached:
                return cached, "osm-cache"
        except Exception:
            pass
    try:
        roads = fetch_roads(lat, lon)
    except Exception as e:
        print(f"[evacuation] Overpass fetch failed for {dam_id}: {e}")
        return None, "unavailable"
    if not roads:
        return None, "unavailable"
    cache.write_text(json.dumps(roads), encoding="utf-8")
    return roads, "osm-live"


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, degrees clockwise from north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def _compass(b: float) -> str:
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int(((b % 360) + 11.25) // 22.5) % 16]


def _subsample(coords: list[tuple[float, float]], max_pts: int = 48) -> list[tuple[float, float]]:
    if len(coords) <= max_pts:
        return coords
    step = len(coords) / max_pts
    return [coords[min(len(coords) - 1, int(i * step))] for i in range(max_pts)]


def _safe_sectors(depth_grid, dam_lat: float, dam_lon: float) -> list[dict]:
    """Bearing sectors from the dam with no modelled water (22.5° sectors)."""
    wet_cells = depth_grid.arr >= WET_THRESHOLD_M
    if not wet_cells.any():
        return []
    nrows, ncols = wet_cells.shape
    west, south, east, north = depth_grid.west, depth_grid.south, depth_grid.east, depth_grid.north
    sectors: dict[int, bool] = {}
    import numpy as np
    rows, cols = np.nonzero(wet_cells)
    for r, c in zip(rows.tolist(), cols.tolist()):
        lat = north - (r + 0.5) / nrows * (north - south)
        lon = west + (c + 0.5) / ncols * (east - west)
        b = bearing_deg(dam_lat, dam_lon, lat, lon)
        s = int(b // 22.5) % 16
        sectors[s] = True
    wet_sectors = set(sectors.keys())
    out = []
    for s in range(16):
        if s in wet_sectors:
            continue
        out.append({
            "sector": f"{_compass(s * 22.5 + 11.25)}",
            "bearing_deg": [round(s * 22.5, 1), round((s + 1) * 22.5, 1)],
            "note": "no modelled inundation in this direction from the dam",
        })
    return out


def analyze(
    *,
    dam: dict,
    depth_grid,
    arrival_grid,
    settlements: list[dict],
    radius_m: int = 12000,
) -> dict:
    """Run the evacuation screening. Never raises for data problems: the
    returned payload always carries an honest data_source."""
    lat, lon = dam.get("lat"), dam.get("lon")
    if lat is None or lon is None:
        return _unavailable("Dam coordinates unavailable — evacuation screening skipped.")
    roads, provenance = _load_roads(str(dam.get("id", "dam")), float(lat), float(lon))
    if roads is None:
        return _unavailable(
            "Road data could not be fetched (OpenStreetMap unreachable) — evacuation candidates unavailable. "
            "The flood, population and asset analysis above is unaffected."
        )

    # ── classify roads by sampling the modelled grids along each ────────────
    road_rows: list[dict] = []
    for road in roads:
        pts = _subsample(road["coords"])
        max_depth = 0.0
        first_arrival = None
        inside = 0
        for plat, plon in pts:
            idx = depth_grid.index(plat, plon)
            if idx is None:
                continue
            inside += 1
            r, c = idx
            d = float(depth_grid.arr[r, c])
            if d > max_depth:
                max_depth = d
            a = float(arrival_grid.arr[r, c])
            if a > 0 and (first_arrival is None or a < first_arrival):
                first_arrival = a
        if inside == 0:
            status = "OUTSIDE_DOMAIN"
        elif max_depth >= FLOODED_ROAD_DEPTH_M:
            status = "FLOODED"
        elif max_depth >= RESTRICTED_ROAD_DEPTH_M:
            status = "RESTRICTED"
        else:
            status = "USABLE"
        # Length (derived, equirectangular).
        length_km = 0.0
        for (a1, o1), (a2, o2) in zip(road["coords"], road["coords"][1:]):
            length_km += overground_distance_m(o1, a1, o2, a2) / 1000.0
        road_rows.append({
            "id": road["id"],
            "name": road["name"],
            "kind": road["kind"],
            "is_bridge": road["is_bridge"],
            "status": status,
            "max_depth_m": round(max_depth, 2),
            "arrival_min": None if first_arrival is None else round(first_arrival, 1),
            "length_km": round(length_km, 2),
            "coords": _subsample(road["coords"], 60),
        })

    unsafe = [r for r in road_rows if r["status"] in ("FLOODED", "RESTRICTED")]
    unsafe.sort(key=lambda r: -ROAD_STATUS_ORDER.get(r["status"], 0) * 1000 - r["max_depth_m"])
    bottlenecks = [r for r in unsafe if r["is_bridge"]]

    usable = [r for r in road_rows if r["status"] == "USABLE"]

    # ── candidate corridors per exposed settlement ──────────────────────────
    corridors: list[dict] = []
    risky = [s for s in settlements if s.get("status") in ("INUNDATED", "AT RISK")]
    risky.sort(key=lambda s: -(s.get("priority", {}).get("score", 0)))
    for s in risky[:12]:
        slat, slon = s["lat"], s["lon"]
        best = None
        best_d = None
        for road in usable:
            for plat, plon in _subsample(road["coords"], 32):
                d = overground_distance_m(slon, slat, plon, plat)
                if best_d is None or d < best_d:
                    best_d = d
                    best = (road, plat, plon)
        if best is None or best_d is None:
            corridors.append({
                "settlement_id": s["id"],
                "settlement_name": s["name"],
                "priority_band": s.get("priority", {}).get("band", "—"),
                "candidate_route": None,
                "status": "NO CANDIDATE",
                "usable_road_distance_km": None,
                "travel_time_min": None,
                "safe_direction": None,
                "flood_risk": s.get("risk", "—"),
                "reasons": ["no usable major road remained inside the modelled domain — "
                            "verify local routes on the ground"],
            })
            continue
        road, rlat, rlon = best
        dist_km = best_d / 1000.0
        travel_min = round(dist_km / EVAC_SPEED_KMH * 60.0, 1)
        safe_b = bearing_deg(float(lat), float(lon), slat, slon)
        corridors.append({
            "settlement_id": s["id"],
            "settlement_name": s["name"],
            "priority_band": s.get("priority", {}).get("band", "—"),
            "candidate_route": road["name"],
            "candidate_kind": road["kind"],
            "candidate_path": [[slon, slat], [rlon, rlat]],
            "status": "RECOMMENDED CANDIDATE" if dist_km <= 5.0 else "MARGINAL",
            "usable_road_distance_km": round(dist_km, 2),
            "travel_time_min": travel_min,
            "safe_direction": f"{_compass(safe_b)} (away from the dam, bearing {safe_b:.0f}°)",
            "flood_risk": s.get("risk", "—"),
            "reasons": [
                f"nearest non-flooded major road: {road['name']} ({road['kind'].replace('_', ' ')})",
                f"{dist_km:.1f} km from the settlement — ~{travel_min:.0f} min at the documented {EVAC_SPEED_KMH:.0f} km/h screening speed",
                "candidate only — field verification required; the model does not route traffic",
            ],
        })

    safe_zone = _safe_sectors(depth_grid, float(lat), float(lon))

    return {
        "data_source": provenance,
        "note": (
            "Major roads and bridges from OpenStreetMap sampled against the modelled flood grids. "
            "Corridors are screening candidates for ground verification, not certified escape routes."
            if provenance != "unavailable" else "Road data unavailable."
        ),
        "thresholds": {
            "flooded_road_depth_m": FLOODED_ROAD_DEPTH_M,
            "restricted_road_depth_m": RESTRICTED_ROAD_DEPTH_M,
            "travel_speed_kmh": EVAC_SPEED_KMH,
        },
        "roads_total": len(road_rows),
        "unsafe_roads": [
            {k: v for k, v in r.items() if k != "coords"} for r in unsafe[:12]
        ],
        "unsafe_road_paths": [r["coords"] for r in unsafe[:8]],
        "bottlenecks": [
            {k: v for k, v in r.items() if k != "coords"} for r in bottlenecks[:6]
        ],
        "corridors": corridors,
        "safe_zone": {
            "sectors": safe_zone,
            "note": ("Bearing sectors from the dam with no modelled inundation in this scenario."
                     if safe_zone else "Modelled water covers every bearing sector from the dam in this scenario."),
        },
    }


def _unavailable(note: str) -> dict:
    return {
        "data_source": "unavailable",
        "note": note,
        "thresholds": {
            "flooded_road_depth_m": FLOODED_ROAD_DEPTH_M,
            "restricted_road_depth_m": RESTRICTED_ROAD_DEPTH_M,
            "travel_speed_kmh": EVAC_SPEED_KMH,
        },
        "roads_total": 0,
        "unsafe_roads": [],
        "unsafe_road_paths": [],
        "bottlenecks": [],
        "corridors": [],
        "safe_zone": {"sectors": [], "note": "Road/flood data unavailable — safe-zone sectors not computed."},
    }
