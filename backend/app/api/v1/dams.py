"""
DamSafe Twin — Dams Router

CRUD endpoints for dam inventory.
"""

from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db
from app.models import Dam

router = APIRouter()


class DamCreate(BaseModel):
    name: str
    latitude: float = Field(..., ge=-90, le=90, description="WGS84 latitude")
    longitude: float = Field(..., ge=-180, le=180, description="WGS84 longitude")
    state: Optional[str] = None
    river: Optional[str] = None
    dam_type: Optional[str] = None
    height_m: Optional[float] = None
    crest_length_m: Optional[float] = None
    spillway_count: Optional[int] = None
    reservoir_capacity_mcm: Optional[float] = None
    year_built: Optional[int] = None
    owner_operator: Optional[str] = None
    river_basin: Optional[str] = None
    material_type: Optional[str] = None
    spillway_capacity_cumecs: Optional[float] = None
    max_water_level_m: Optional[float] = None
    full_reservoir_level_m: Optional[float] = None
    normal_operating_level_m: Optional[float] = None
    structural_notes: Optional[str] = None
    operating_notes: Optional[str] = None
    metadata_: Optional[dict] = None


class DamUpdate(BaseModel):
    name: Optional[str] = None
    latitude: Optional[float] = Field(None, ge=-90, le=90)
    longitude: Optional[float] = Field(None, ge=-180, le=180)
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
    """Register a dam: DB inventory row + canonical registry entry.

    The full onboarding form (river/basin, owner, material type, spillway
    capacity, levels, operating notes) is persisted: DB row keeps the core,
    the registry entry carries everything so profiles, condition assessment
    and (with a DEM) all simulation paths work for the new dam.
    """
    dam = Dam(
        name=data.name,
        dam_type=data.dam_type,
        height_m=data.height_m,
        crest_length_m=data.crest_length_m,
        spillway_count=data.spillway_count,
        reservoir_capacity_mcm=data.reservoir_capacity_mcm,
        metadata_=data.metadata_,
        # PostGIS point from the supplied coordinates (lon/lat order in WKT).
        location=func.ST_SetSRID(
            func.ST_MakePoint(data.longitude, data.latitude), 4326),
    )
    db.add(dam)
    await db.flush()
    await db.refresh(dam)

    # Canonical registry entry (runtime registrations live beside the other
    # local stores; curated entries always win on id clash).
    from app.sandbox.dam_registry import register_dam

    rid = f"r{str(dam.id)[:8]}"
    entry = {
        "id": rid,
        "name": data.name,
        "state": data.state or "",
        "lon": data.longitude, "lat": data.latitude,
        "height_m": data.height_m,
        "type": data.material_type or data.dam_type,
        "river": data.river or data.river_basin or "",
        "capacity_mcm": data.reservoir_capacity_mcm,
        "year_built": data.year_built,
        "owner_operator": data.owner_operator,
        "river_basin": data.river_basin,
        "material_type": data.material_type,
        "spillway_capacity_cumecs": data.spillway_capacity_cumecs,
        "max_water_level_m": data.max_water_level_m,
        "full_reservoir_level_m": data.full_reservoir_level_m,
        "normal_operating_level_m": data.normal_operating_level_m,
        "structural_notes": data.structural_notes,
        "operating_notes": data.operating_notes,
        "db_id": str(dam.id),
    }
    register_dam(entry)
    return dam


@router.get("")
async def list_dams(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """List all dams with their WGS84 coordinates."""
    count_result = await db.execute(select(func.count(Dam.id)))
    total = count_result.scalar()

    result = await db.execute(
        select(Dam,
               func.ST_X(Dam.location).label("lon"),
               func.ST_Y(Dam.location).label("lat"))
        .order_by(Dam.name).offset(offset).limit(limit)
    )
    rows = result.all()
    return {
        "total": total,
        "dams": [
            {
                "id": str(d.id),
                "name": d.name,
                "longitude": lon,
                "latitude": lat,
                "dam_type": d.dam_type,
                "height_m": d.height_m,
                "crest_length_m": d.crest_length_m,
                "spillway_count": d.spillway_count,
                "reservoir_capacity_mcm": d.reservoir_capacity_mcm,
            }
            for d, lon, lat in rows
        ],
    }


@router.get("/{dam_id}")
async def get_dam(
    dam_id: UUID,
    user: CurrentUser = Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Get a dam by ID with its WGS84 coordinates."""
    result = await db.execute(
        select(Dam,
               func.ST_X(Dam.location).label("lon"),
               func.ST_Y(Dam.location).label("lat"))
        .where(Dam.id == dam_id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Dam not found")
    dam, lon, lat = row
    return {
        "id": str(dam.id),
        "name": dam.name,
        "longitude": lon,
        "latitude": lat,
        "dam_type": dam.dam_type,
        "height_m": dam.height_m,
        "crest_length_m": dam.crest_length_m,
        "spillway_count": dam.spillway_count,
        "reservoir_capacity_mcm": dam.reservoir_capacity_mcm,
    }


@router.patch("/{dam_id}")
async def update_dam(
    dam_id: UUID,
    data: DamUpdate,
    user: CurrentUser = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Update dam attributes and/or relocate it (both coords required to move)."""
    result = await db.execute(select(Dam).where(Dam.id == dam_id))
    dam = result.scalar_one_or_none()
    if not dam:
        raise HTTPException(status_code=404, detail="Dam not found")
    for field in ("name", "dam_type", "height_m", "crest_length_m",
                  "spillway_count", "reservoir_capacity_mcm", "metadata_"):
        value = getattr(data, field)
        if value is not None:
            setattr(dam, field, value)
    if data.latitude is not None or data.longitude is not None:
        if data.latitude is None or data.longitude is None:
            raise HTTPException(
                status_code=422,
                detail="latitude and longitude must be supplied together",
            )
        dam.location = func.ST_SetSRID(
            func.ST_MakePoint(data.longitude, data.latitude), 4326)
    await db.flush()
    await db.refresh(dam)
    lon = await db.scalar(select(func.ST_X(Dam.location)).where(Dam.id == dam.id))
    lat = await db.scalar(select(func.ST_Y(Dam.location)).where(Dam.id == dam.id))
    return {
        "id": str(dam.id), "name": dam.name,
        "longitude": lon, "latitude": lat,
        "dam_type": dam.dam_type, "height_m": dam.height_m,
        "crest_length_m": dam.crest_length_m,
        "spillway_count": dam.spillway_count,
        "reservoir_capacity_mcm": dam.reservoir_capacity_mcm,
    }


@router.get("/registry/summary")
async def registry_summary(user: CurrentUser = Depends(require_role("viewer"))):
    """Per-dam registry summary for the Admin panel.

    One row per canonical registry dam: identity, available documentation,
    last report date, data completeness, condition category and simulation
    availability. Click-through uses the dam id used by the sandbox/impact.
    """
    from app.sandbox.dam_registry import all_dams
    from app.damprofile import (
        _docs_path, _load_json, _profile_path, completeness_score, OSINT_NOTES,
    )
    from app.sandbox.terrain import locate_dem
    import time as _time

    out = []
    for rec in all_dams():
        dam_id = rec["id"]
        docs = _load_json(_docs_path(dam_id), [])
        profile = _load_json(_profile_path(dam_id), {})
        last_doc = max((d.get("uploaded_at_utc", "") for d in docs), default=None)
        has_recent = any(
            (d.get("uploaded_at_utc") or "")[:4].isdigit()
            and _time.gmtime().tm_year - int((d.get("uploaded_at_utc") or "0000")[:4]) <= 5
            for d in docs
        )
        cond = "INSUFFICIENT_DATA"
        if docs:
            topics = [i.get("topic") for d in docs for i in d.get("issues", [])]
            poor = any(d.get("reported_condition") in ("poor", "unsatisfactory") for d in docs)
            cond = "HIGH_CONCERN" if poor else ("MODERATE_CONCERN" if topics else "LOW_CONCERN")
        elif OSINT_NOTES.get(dam_id):
            cond = "MODERATE_CONCERN"
        out.append({
            "dam_id": dam_id,
            "name": rec.get("name"),
            "state": rec.get("state"),
            "dam_type": rec.get("type"),
            "river": rec.get("river"),
            "height_m": rec.get("height_m"),
            "year_built": rec.get("year_built"),
            "documents": len(docs),
            "last_report_utc": last_doc,
            "recent_report_5y": has_recent,
            "completeness": completeness_score(rec, profile, docs),
            "condition": cond,
            "simulation_available": locate_dem(dam_id) is not None,
        })
    return {"total": len(out), "dams": out}


@router.delete("/{dam_id}")
async def delete_dam(
    dam_id: UUID,
    user: CurrentUser = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Delete a dam with no dependent scenarios (admin only)."""
    from app.models import Scenario
    result = await db.execute(select(Dam).where(Dam.id == dam_id))
    dam = result.scalar_one_or_none()
    if not dam:
        raise HTTPException(status_code=404, detail="Dam not found")
    dep = await db.scalar(
        select(func.count(Scenario.id)).where(Scenario.dam_id == dam_id))
    if dep:
        raise HTTPException(
            status_code=409,
            detail=f"Dam has {dep} scenario(s); delete or reassign them first",
        )
    await db.delete(dam)
    await db.flush()
    return {"id": str(dam_id), "deleted": True}
