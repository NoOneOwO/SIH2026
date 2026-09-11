"""
DamSafe Twin Sandbox — critical-asset exposure inventory.

Honesty rule: every asset carries `source`. 'osm' = real OpenStreetMap
data (fetched live once, then cached — never fabricated). 'modeled' =
documented downstream sample points used ONLY when no OSM data is
available; the frontend must label these as modeled, never as real
villages/hospitals/roads.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import requests

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
CACHE_DIR = Path(os.environ.get("DAMSAFE_ASSETS_CACHE", str(BACKEND_DIR / "app" / "sandbox" / "assets_cache")))
OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
CACHE_TTL_DAYS = 30


def _cache_path(dam_id: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{dam_id}.json"


def _fresh(path: Path) -> bool:
    try:
        age_days = (time.time() - path.stat().st_mtime) / 86400
        return age_days < CACHE_TTL_DAYS
    except OSError:
        return False


def fetch_osm(lat: float, lon: float, radius_m: float = 8000) -> list[dict]:
    """Small Overpass query: settlements, hospitals, bridges, power infra."""
    # ~8 km radius keeps the query cheap; short timeout, one attempt here
    # (the caller treats failure as 'no OSM available').
    query = f"""
    [out:json][timeout:60];
    (
      node["place"~"^(village|town|hamlet)$"](around:{radius_m},{lat},{lon});
      node["amenity"="hospital"](around:{radius_m},{lat},{lon});
      way["bridge"="yes"](around:{radius_m},{lat},{lon});
      node["power"~"^(substation|plant)$"](around:{radius_m},{lat},{lon});
    );
    out center 50;
    """.strip()
    r = requests.post(OVERPASS_URL, data={"data": query}, timeout=70)
    r.raise_for_status()
    data = r.json()
    assets = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "node":
            alat, alon = el["lat"], el["lon"]
        else:
            c = el.get("center", {})
            alat, alon = c.get("lat"), c.get("lon")
        if alat is None:
            continue
        if "place" in tags:
            kind = "village"
        elif tags.get("amenity") == "hospital":
            kind = "hospital"
        elif "bridge" in tags:
            kind = "bridge"
        else:
            kind = "power"
        assets.append({
            "name": tags.get("name", f"Unnamed {kind}"),
            "kind": kind, "lat": alat, "lon": alon, "source": "osm",
        })
    return assets


def modeled_points(lat: float, lon: float) -> list[dict]:
    """Documented fallback: 12 downstream sample points (NOT real assets)."""
    pts = []
    for ring, (radius_km, n) in enumerate([(2.0, 3), (4.0, 4), (6.0, 5)]):
        for i in range(n):
            ang = 2 * math.pi * (i / n) + ring * 0.5
            dlat = radius_km * math.cos(ang) / 110.54
            dlon = radius_km * math.sin(ang) / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
            pts.append({
                "name": f"Exposure point R{radius_km:.0f}km-{i + 1}",
                "kind": "modeled_point",
                "lat": lat + dlat, "lon": lon + dlon,
                "source": "modeled",
            })
    return pts


def load_assets(dam_id: str, lat: float, lon: float) -> tuple[list[dict], str]:
    """(assets, provenance). Cached OSM preferred; modeled fallback otherwise."""
    cache = _cache_path(dam_id)
    if cache.exists() and _fresh(cache):
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if cached:
                return cached, "osm-cache"
        except Exception:
            pass
    try:
        assets = fetch_osm(lat, lon)
        if assets:
            cache.write_text(json.dumps(assets, indent=2), encoding="utf-8")
            return assets, "osm-live"
    except Exception as e:
        print(f"[sandbox] OSM fetch failed for {dam_id}: {e}")
    return modeled_points(lat, lon), "modeled-fallback"
