"""
DamSafe Twin — Audit Query Endpoints

Provides read-only access to the immutable audit trail.
"""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import CurrentUser, require_role
from app.database import get_db

router = APIRouter()


@router.get("")
async def get_audit_log(
    entity: Optional[str] = Query(None, description="Filter by entity type (e.g. 'scenario', 'sim-run')"),
    entity_id: Optional[UUID] = Query(None, description="Filter by specific entity UUID"),
    actor_id: Optional[UUID] = Query(None, description="Filter by actor UUID"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Query the immutable audit trail. Requires analyst role or higher."""
    query = "SELECT id, actor_id, action, entity, entity_id, diff, at FROM audit_log WHERE 1=1"
    params = {}

    if entity:
        query += " AND entity = :entity"
        params["entity"] = entity
    if entity_id:
        query += " AND entity_id = :entity_id"
        params["entity_id"] = str(entity_id)
    if actor_id:
        query += " AND actor_id = :actor_id"
        params["actor_id"] = str(actor_id)

    query += " ORDER BY at DESC LIMIT :limit OFFSET :offset"
    params["limit"] = limit
    params["offset"] = offset

    result = await db.execute(text(query), params)
    rows = result.mappings().all()

    # Get total count
    count_query = "SELECT COUNT(*) FROM audit_log WHERE 1=1"
    count_params = {}
    if entity:
        count_query += " AND entity = :entity"
        count_params["entity"] = entity
    if entity_id:
        count_query += " AND entity_id = :entity_id"
        count_params["entity_id"] = str(entity_id)
    if actor_id:
        count_query += " AND actor_id = :actor_id"
        count_params["actor_id"] = str(actor_id)

    count_result = await db.execute(text(count_query), count_params)
    total = count_result.scalar()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "entries": [dict(r) for r in rows],
    }
