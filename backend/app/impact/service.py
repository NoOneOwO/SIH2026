"""
DamSafe Twin — Impact Analysis Service

Computes hazard index, evacuation priority, road passability, and shelter allocation
from precomputed simulation results.
"""

from typing import Optional, List
from uuid import UUID
import math

from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import (
    SimRun, Village, Road, RoadStatus, Facility, Shelter,
    EvacuationPriority,
)

settings = get_settings()


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


async def compute_evacuation_priorities(db: AsyncSession, sim_run_id: UUID) -> List[dict]:
    """
    Compute evacuation priority for all villages downstream of the dam.
    Uses mock hazard data; in production, this reads from precomputed COGs.
    """
    # Get all villages
    villages_result = await db.execute(select(Village))
    villages = villages_result.scalars().all()

    priorities = []
    for village in villages:
        # In production: sample depth/velocity from precomputed raster at village location
        # For MVP: use representative values based on distance (mock)
        mock_depth = 1.5  # would come from raster
        mock_velocity = 2.0  # would come from raster
        mock_arrival_min = 45.0  # would come from arrival_time raster

        hazard = compute_hazard_index(mock_depth, mock_velocity)
        priority = compute_evacuation_priority(
            exposure=float(village.population or 100),
            hazard=hazard,
            vulnerability=1.0,
            arrival_time_min=mock_arrival_min,
        )

        priorities.append({
            "village_id": str(village.id),
            "village_name": village.name,
            "population": village.population,
            "depth_m": mock_depth,
            "velocity_ms": mock_velocity,
            "hazard_index": round(hazard, 4),
            "hazard_class": classify_hazard(hazard),
            "arrival_time_min": mock_arrival_min,
            "priority_score": round(priority, 4),
        })

    # Sort by priority score descending (most urgent first)
    priorities.sort(key=lambda x: x["priority_score"], reverse=True)

    # Store in DB
    for i, p in enumerate(priorities):
        ep = EvacuationPriority(
            sim_run_id=sim_run_id,
            village_id=UUID(p["village_id"]),
            exposure=float(p["population"]),
            hazard=p["hazard_index"],
            vulnerability=1.0,
            arrival_time_min=p["arrival_time_min"],
            warning_time_min=0.0,
            mobilize_time_min=15.0,
            priority_score=p["priority_score"],
        )
        db.add(ep)

    await db.flush()
    return priorities


async def compute_road_status(db: AsyncSession, sim_run_id: UUID, t_minutes: int) -> List[dict]:
    """
    Compute road passability at a given time step.
    In production: reads from precomputed depth/velocity rasters.
    """
    roads_result = await db.execute(select(Road))
    roads = roads_result.scalars().all()

    statuses = []
    for road in roads:
        # Mock: use distance-based heuristic
        mock_depth = max(0, 2.0 - (t_minutes / 60.0))
        mock_velocity = max(0, 1.5 - (t_minutes / 120.0))
        status = classify_road_status(mock_depth, mock_velocity)

        rs = RoadStatus(
            sim_run_id=sim_run_id,
            road_id=road.id,
            t_minutes=t_minutes,
            status=status,
        )
        db.add(rs)
        statuses.append({
            "road_id": str(road.id),
            "road_name": road.name,
            "status": status,
            "depth_m": round(mock_depth, 3),
            "velocity_ms": round(mock_velocity, 3),
        })

    await db.flush()
    return statuses


async def get_critical_facilities(db: AsyncSession) -> List[dict]:
    """List all critical facilities in the downstream area."""
    result = await db.execute(select(Facility))
    facilities = result.scalars().all()
    return [
        {
            "id": str(f.id),
            "name": f.name,
            "kind": f.kind,
        }
        for f in facilities
    ]
