"""
DamSafe Twin — GIS/Data Pipeline Router

Endpoints for DEM versions, roughness maps, and data quality information.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.gis import service

router = APIRouter()


@router.get("/dem/{dam_id}")
async def list_dem_versions(
    dam_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List DEM versions for a dam."""
    versions = await service.list_dem_versions(db, dam_id)
    return {
        "dam_id": str(dam_id),
        "versions": [
            {
                "id": str(v.id),
                "source": v.source,
                "resolution_m": v.resolution_m,
                "quality_grade": v.quality_grade,
                "conditioning_steps": v.conditioning_steps,
                "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in versions
        ],
    }


@router.get("/dem/{dam_id}/{dem_id}")
async def get_dem_quality_report(
    dam_id: UUID,
    dem_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get data quality report for a DEM version."""
    dem = await service.get_dem_version(db, dem_id)
    if not dem:
        raise HTTPException(status_code=404, detail="DEM version not found")

    return {
        "id": str(dem.id),
        "source": dem.source,
        "resolution_m": dem.resolution_m,
        "quality_grade": dem.quality_grade,
        "conditioning_steps": dem.conditioning_steps,
        "disclaimer": service.get_quality_disclaimer(dem.quality_grade),
    }


@router.get("/roughness/{dam_id}")
async def list_roughness_maps(
    dam_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List roughness maps for a dam."""
    maps = await service.list_roughness_maps(db, dam_id)
    return {
        "dam_id": str(dam_id),
        "maps": [
            {
                "id": str(m.id),
                "name": m.name,
                "source": m.source,
                "method": m.method,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in maps
        ],
    }


@router.get("/mannings-n")
async def get_mannings_n_table(
    user: CurrentUser = Depends(require_role("viewer")),
):
    """Get the Manning's n lookup table for land cover types."""
    return {
        "table": service.MANNINGS_N_LULC,
        "note": "Values are configurable policy parameters. Production values should be reviewed by qualified engineers.",
    }
