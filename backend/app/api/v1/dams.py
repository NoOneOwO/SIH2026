"""
DamSafe Twin — Dams Router

CRUD endpoints for dam inventory.
"""

from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.models import Dam

router = APIRouter()


class DamCreate(BaseModel):
    name: str
    dam_type: Optional[str] = None
    height_m: Optional[float] = None
    crest_length_m: Optional[float] = None
    spillway_count: Optional[int] = None
    reservoir_capacity_mcm: Optional[float] = None
    metadata_: Optional[dict] = None


class DamResponse(BaseModel):
    id: UUID
    name: str
    dam_type: Optional[str]
    height_m: Optional[float]
    crest_length_m: Optional[float]
    spillway_count: Optional[int]
    reservoir_capacity_mcm: Optional[float]

    class Config:
        from_attributes = True


@router.post("", response_model=DamResponse, status_code=201)
async def create_dam(
    data: DamCreate,
    user: CurrentUser = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Create a new dam entry."""
    dam = Dam(
        name=data.name,
        dam_type=data.dam_type,
        height_m=data.height_m,
        crest_length_m=data.crest_length_m,
        spillway_count=data.spillway_count,
        reservoir_capacity_mcm=data.reservoir_capacity_mcm,
        metadata_=data.metadata_,
    )
    # Note: location is required in the model; in production, accept via separate geo field
    # For MVP we'll set a default point
    from sqlalchemy import text
    dam.location = "SRID=4326;POINT(77.2 28.6)"  # Default placeholder
    db.add(dam)
    await db.flush()
    await db.refresh(dam)
    return dam


@router.get("")
async def list_dams(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List all dams."""
    count_result = await db.execute(select(func.count(Dam.id)))
    total = count_result.scalar()

    result = await db.execute(
        select(Dam).order_by(Dam.name).offset(offset).limit(limit)
    )
    dams = result.scalars().all()
    return {
        "total": total,
        "dams": [
            {
                "id": str(d.id),
                "name": d.name,
                "dam_type": d.dam_type,
                "height_m": d.height_m,
                "crest_length_m": d.crest_length_m,
                "spillway_count": d.spillway_count,
                "reservoir_capacity_mcm": d.reservoir_capacity_mcm,
            }
            for d in dams
        ],
    }


@router.get("/{dam_id}")
async def get_dam(
    dam_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get a dam by ID."""
    result = await db.execute(select(Dam).where(Dam.id == dam_id))
    dam = result.scalar_one_or_none()
    if not dam:
        raise HTTPException(status_code=404, detail="Dam not found")
    return {
        "id": str(dam.id),
        "name": dam.name,
        "dam_type": dam.dam_type,
        "height_m": dam.height_m,
        "crest_length_m": dam.crest_length_m,
        "spillway_count": dam.spillway_count,
        "reservoir_capacity_mcm": dam.reservoir_capacity_mcm,
    }
