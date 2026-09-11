"""
DamSafe Twin — GIS/Data Pipeline Service

DEM conditioning, quality grading, data ingestion utilities.
"""

from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DEMVersion, RoughnessMap


async def get_dem_version(db: AsyncSession, dem_id: UUID) -> Optional[DEMVersion]:
    """Get a DEM version by ID."""
    result = await db.execute(select(DEMVersion).where(DEMVersion.id == dem_id))
    return result.scalar_one_or_none()


async def list_dem_versions(db: AsyncSession, dam_id: UUID):
    """List DEM versions for a dam."""
    result = await db.execute(
        select(DEMVersion).where(DEMVersion.dam_id == dam_id).order_by(DEMVersion.created_at.desc())
    )
    return result.scalars().all()


async def get_roughness_map(db: AsyncSession, map_id: UUID) -> Optional[RoughnessMap]:
    """Get a roughness map by ID."""
    result = await db.execute(select(RoughnessMap).where(RoughnessMap.id == map_id))
    return result.scalar_one_or_none()


async def list_roughness_maps(db: AsyncSession, dam_id: UUID):
    """List roughness maps for a dam."""
    result = await db.execute(
        select(RoughnessMap).where(RoughnessMap.dam_id == dam_id).order_by(RoughnessMap.created_at.desc())
    )
    return result.scalars().all()


def compute_data_quality_score(
    resolution_m: float,
    source: str,
    has_conditioning: bool,
    has_bathymetry: bool = False,
) -> str:
    """
    Compute data quality grade based on DEM characteristics.
    Returns one of: prototype, planning_grade, engineering_reviewed, operationally_approved
    """
    score = 0

    # Resolution scoring
    if resolution_m <= 5:
        score += 3
    elif resolution_m <= 10:
        score += 2
    elif resolution_m <= 30:
        score += 1

    # Source scoring
    source_scores = {
        "cartodem": 1,
        "bhuvan": 2,
        "srtm": 1,
        "lidar": 3,
        "survey": 4,
        "local_survey": 4,
    }
    score += source_scores.get(source.lower(), 1)

    # Conditioning bonus
    if has_conditioning:
        score += 1
    if has_bathymetry:
        score += 1

    # Grade mapping
    if score >= 8:
        return "operationally_approved"
    elif score >= 6:
        return "engineering_reviewed"
    elif score >= 4:
        return "planning_grade"
    else:
        return "prototype"


def get_quality_disclaimer(grade: str) -> str:
    """Return the appropriate disclaimer for the given quality grade."""
    disclaimers = {
        "prototype": (
            "PROTOTYPE: This result uses screening-grade data and is for demonstration "
            "purposes only. Do not use for operational decisions."
        ),
        "planning_grade": (
            "PLANNING GRADE: Suitable for planning and preparedness exercises. "
            "Not validated for operational emergency response."
        ),
        "engineering_reviewed": (
            "ENGINEERING REVIEWED: This result has been reviewed by a qualified engineer "
            "but has not received formal operational approval."
        ),
        "operationally_approved": (
            "OPERATIONALLY APPROVED: This result has been formally approved for "
            "operational use by an authorized approver."
        ),
    }
    return disclaimers.get(grade, "Unknown quality grade")


# Manning's n lookup table (LULC → roughness)
MANNINGS_N_LULC = {
    "open_water": 0.030,
    "floodplain_grass": 0.035,
    "cultivated": 0.035,
    "forest": 0.050,
    "urban_low": 0.040,
    "urban_high": 0.060,
    "bare_soil": 0.025,
    "wetland": 0.050,
    "channel_main": 0.030,
    "channel_floodplain": 0.040,
    "gravel_bed": 0.035,
    "default": 0.035,
}


def get_mannings_n(land_cover_type: str) -> float:
    """Get Manning's n value for a given land cover type."""
    return MANNINGS_N_LULC.get(land_cover_type.lower(), MANNINGS_N_LULC["default"])
