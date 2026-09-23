"""
DamSafe Twin — Impact Analysis Service

Computes hazard index, evacuation priority, road passability, and facility
exposure from the simulation's own result grids (embedded in
``SimRun.result_layers`` by the solver worker — see ``app.impact.grids``).

Idempotency: computed rows are stored once per (sim_run[, t_minutes]) and
served from the database on repeat calls. GET endpoints never fabricate
hydraulics: a run without result grids raises instead of returning mocks.
"""

from typing import List, Optional
from uuid import UUID
import math

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from shapely import wkt as shapely_wkt

from app.config import get_settings
from app.models import (
    SimRun, Village, Road, RoadStatus, Facility,
    EvacuationPriority,
)
from app.impact import grids as grid_codec

settings = get_settings()


class NoResultGridsError(ValueError):
    """Raised when a sim run carries no usable result grids."""


def compute_hazard_index(depth: float, velocity: float) -> float:
    """
    H(x,y,t) = h(x,y,t) * sqrt(u^2 + v^2)
    Simple depth-velocity product for hazard classification.
    """
    return depth * math.sqrt(velocity ** 2)


def classify_hazard(hazard_value: float) -> str:
    """Classify hazard into color categories based on configurable thresholds."""
    if hazard_value <= settings.HAZARD_GREEN_MAX:
        return "green"
    elif hazard_value <= settings.HAZARD_YELLOW_MAX:
        return "yellow"
    elif hazard_value <= settings.HAZARD_ORANGE_MAX:
        return "orange"
    else:
        return "red"


def compute_evacuation_priority(
    exposure: float,
    hazard: float,
    vulnerability: float,
    arrival_time_min: float,
    warning_time_min: float = 0.0,
    mobilize_time_min: float = 15.0,
) -> float:
    """
    Evacuation priority score:
    P_i = (E_i * H_i * V_i) / max(T_arrival,i - T_warning - T_mobilize, epsilon)

    Higher score = more urgent evacuation.
    """
    epsilon = 0.01
    effective_time = max(arrival_time_min - warning_time_min - mobilize_time_min, epsilon)
    return (exposure * hazard * vulnerability) / effective_time


def classify_road_status(depth: float, velocity: float) -> str:
    """Classify road passability based on water depth and velocity at road segments."""
    if (
        depth >= settings.ROAD_IMPASSABLE_DEPTH_M
        or velocity >= settings.ROAD_IMPASSABLE_VELOCITY_MS
    ):
        return "impassable"
    elif depth >= settings.ROAD_RESTRICTED_DEPTH_M:
        return "restricted"
    else:
        return "safe"


def _require_grids(sim_run: SimRun) -> dict:
    decoded = grid_codec.decode_grids(sim_run.result_layers)
    if decoded is None:
        raise NoResultGridsError(
            f"Sim run {sim_run.id} has no embedded result grids "
            "(run predates grid capture, failed, or used an external engine). "
            "Re-run the simulation to compute impact."
        )
    return decoded


def _vulnerability_of(metadata: Optional[dict]) -> float:
    if isinstance(metadata, dict):
        try:
            v = float(metadata.get("vulnerability", 1.0))
            return min(max(v, 0.1), 5.0)
        except (TypeError, ValueError):
            pass
    return 1.0


def _priority_dict(village, row: EvacuationPriority, depth: float,
                   velocity: float, hazard: float) -> dict:
    return {
        "village_id": str(village.id),
        "village_name": village.name,
        "population": village.population,
        "depth_m": round(depth, 3),
        "velocity_ms": round(velocity, 3),
        "hazard_index": round(hazard, 4),
        "hazard_class": classify_hazard(hazard),
        "arrival_time_min": row.arrival_time_min,
        "priority_score": round(row.priority_score, 4),
    }


async def compute_evacuation_priorities(db: AsyncSession, sim_run_id: UUID) -> List[dict]:
    """Evacuation priority for all villages, sampled from the run's own grids.

    Stored rows are returned as-is on repeat calls (idempotent). First call
    samples every village point against the embedded grids and persists rows.
    """
    from app.simulation.service import get_sim_run
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise ValueError(f"Sim run {sim_run_id} not found")

    existing = (
        await db.execute(
            select(EvacuationPriority, Village,
                   func.ST_X(Village.geom).label("lon"),
                   func.ST_Y(Village.geom).label("lat"))
            .join(Village, Village.id == EvacuationPriority.village_id)
            .where(EvacuationPriority.sim_run_id == sim_run_id)
            .order_by(EvacuationPriority.priority_score.desc())
        )
    ).all()
    if existing:
        decoded = _require_grids(sim_run)
        out = []
        for row, village, lon, lat in existing:
            if lon is not None and lat is not None:
                s = grid_codec.sample_point(decoded, float(lon), float(lat))
                depth, velocity = s["depth_m"], s["velocity_ms"]
            else:
                depth, velocity = 0.0, 0.0
            hazard = compute_hazard_index(depth, velocity)
            out.append(_priority_dict(village, row, depth, velocity, hazard))
        return out

    decoded = _require_grids(sim_run)
    rows = (
        await db.execute(
            select(Village,
                   func.ST_X(Village.geom).label("lon"),
                   func.ST_Y(Village.geom).label("lat"))
        )
    ).all()

    computed = []
    for village, lon, lat in rows:
        if lon is None or lat is None:
            continue
        s = grid_codec.sample_point(decoded, float(lon), float(lat))
        if s["outside"] or s["arrival_min"] is None:
            depth, velocity, arrival = 0.0, 0.0, None
        else:
            depth, velocity, arrival = s["depth_m"], s["velocity_ms"], s["arrival_min"]
        hazard = compute_hazard_index(depth, velocity)
        vulnerability = _vulnerability_of(village.metadata_)
        priority = compute_evacuation_priority(
            exposure=float(village.population or 100),
            hazard=hazard,
            vulnerability=vulnerability,
            arrival_time_min=arrival if arrival is not None else 1e6,
        )
        ep = EvacuationPriority(
            sim_run_id=sim_run_id,
            village_id=village.id,
            exposure=float(village.population or 0),
            hazard=round(hazard, 4),
            vulnerability=vulnerability,
            arrival_time_min=arrival,
            warning_time_min=0.0,
            mobilize_time_min=15.0,
            priority_score=round(priority, 4),
        )
        db.add(ep)
        computed.append((priority, village, ep, depth, velocity, hazard))

    await db.flush()
    computed.sort(key=lambda t: t[0], reverse=True)
    return [_priority_dict(v, ep, depth, velocity, hazard)
            for _, v, ep, depth, velocity, hazard in computed]


async def compute_road_status(db: AsyncSession, sim_run_id: UUID, t_minutes: int) -> List[dict]:
    """Road passability at t minutes, from the run's own grids.

    A segment is wet at time t where the arrival grid says water has arrived
    (0 <= arrival_min <= t); depth/velocity come from the max grids under that
    mask. Rows are stored per (sim_run, t) and re-served idempotently.
    """
    from app.simulation.service import get_sim_run
    sim_run = await get_sim_run(db, sim_run_id)
    if not sim_run:
        raise ValueError(f"Sim run {sim_run_id} not found")

    existing = (
        await db.execute(
            select(RoadStatus, Road)
            .join(Road, Road.id == RoadStatus.road_id)
            .where(RoadStatus.sim_run_id == sim_run_id, RoadStatus.t_minutes == t_minutes)
        )
    ).all()
    if existing:
        decoded = _require_grids(sim_run)
        out = []
        for rs, road in existing:
            depth, velocity = _road_max_at_t(decoded, await _road_wkt(db, road), t_minutes)
            out.append({
                "road_id": str(road.id),
                "road_name": road.name,
                "status": rs.status,
                "depth_m": round(depth, 3),
                "velocity_ms": round(velocity, 3),
            })
        return out

    decoded = _require_grids(sim_run)
    roads = (await db.execute(select(Road))).scalars().all()
    statuses = []
    for road in roads:
        wkt_text = await _road_wkt(db, road)
        depth, velocity = _road_max_at_t(decoded, wkt_text, t_minutes)
        status = classify_road_status(depth, velocity)
        db.add(RoadStatus(
            sim_run_id=sim_run_id, road_id=road.id,
            t_minutes=t_minutes, status=status,
        ))
        statuses.append({
            "road_id": str(road.id),
            "road_name": road.name,
            "status": status,
            "depth_m": round(depth, 3),
            "velocity_ms": round(velocity, 3),
        })
    await db.flush()
    return statuses


def _road_max_at_t(decoded: dict, wkt_text: str, t_minutes: int) -> tuple[float, float]:
    """Max depth/velocity over a road's vertices at time t (conservative)."""
    import numpy as np
    depth = decoded["depth"]
    velocity = decoded["velocity"]
    arrival = decoded["arrival_min"]
    wet_now = (arrival >= 0) & (arrival <= float(t_minutes))
    depth_t = np.where(wet_now, depth, 0.0)
    vel_t = np.where(wet_now, velocity, 0.0)
    try:
        geom = shapely_wkt.loads(wkt_text)
        coords = list(geom.coords)
    except Exception:
        return 0.0, 0.0
    meta = decoded["meta"]
    cell_m = float(meta.get("cell_m") or 10.0)
    nrows = int(meta["nrows"])
    ncols = int(meta["ncols"])
    best_d = best_v = 0.0
    for lon, lat in coords:
        dist = grid_codec.overground_distance_m(
            float(meta["origin_lon"]), float(meta["origin_lat"]), lon, lat)
        row = min(max(int(round(dist / cell_m)), 0), nrows - 1)
        col = ncols // 2
        best_d = max(best_d, float(depth_t[row, col]))
        best_v = max(best_v, float(vel_t[row, col]))
    return best_d, best_v


async def _road_wkt(db: AsyncSession, road) -> str:
    return await db.scalar(select(func.ST_AsText(Road.geom)).where(Road.id == road.id))


async def get_hazard_summary(db: AsyncSession, sim_run: SimRun) -> dict:
    """Domain hazard aggregates from the run's own grids (no mocks)."""
    decoded = _require_grids(sim_run)
    stats = grid_codec.summarize(decoded)
    hazard = compute_hazard_index(stats["max_depth_m"], stats["max_velocity_ms"])
    return {
        "sim_run_id": str(sim_run.id),
        "hazard_index": round(hazard, 4),
        "hazard_class": classify_hazard(hazard),
        "max_depth_m": stats["max_depth_m"],
        "max_velocity_ms": stats["max_velocity_ms"],
        "wet_cells": stats["wet_cells"],
        "grid": f"{stats['nrows']}x{stats['ncols']} screening grid",
    }


async def get_critical_facilities(db: AsyncSession, sim_run: SimRun) -> List[dict]:
    """Critical facilities with exposure sampled from the run's own grids."""
    decoded = _require_grids(sim_run)
    rows = (
        await db.execute(
            select(Facility,
                   func.ST_X(Facility.geom).label("lon"),
                   func.ST_Y(Facility.geom).label("lat"))
        )
    ).all()
    out = []
    for fac, lon, lat in rows:
        if lon is None or lat is None:
            continue
        s = grid_codec.sample_point(decoded, float(lon), float(lat))
        inundated = (not s["outside"]) and s["depth_m"] > 0.05 and s["arrival_min"] is not None
        hazard = compute_hazard_index(s["depth_m"], s["velocity_ms"])
        out.append({
            "id": str(fac.id),
            "name": fac.name,
            "kind": fac.kind,
            "depth_m": round(s["depth_m"], 3),
            "hazard_class": classify_hazard(hazard),
            "arrival_min": round(s["arrival_min"], 1) if s["arrival_min"] is not None else None,
            "inundated": inundated,
            "exposure": "inundated" if inundated else "dry",
        })
    out.sort(key=lambda f: (not f["inundated"], -f["depth_m"]))
    return out
