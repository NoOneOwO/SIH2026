"""
DamSafe Twin — Scenario Schemas

Pydantic models for request/response validation on scenario endpoints.
"""

from datetime import datetime
from typing import Optional, Dict, Any, List
from uuid import UUID

from pydantic import BaseModel, Field


# ── Request Schemas ───────────────────────────────────────────────────────────

class ScenarioCreate(BaseModel):
    """Create a new scenario draft."""
    dam_id: UUID
    failure_mode: str = Field(..., pattern="^(piping|overtopping|controlled_release)$")
    variant: str = Field(..., description="e.g. 'lower', 'expected', 'conservative', 'fast', 'worst_credible'")
    breach_params: Dict[str, Any] = Field(
        ...,
        description="Froehlich-derived breach parameters (generator, not truth)",
    )
    dem_version_id: Optional[UUID] = None
    roughness_map_id: Optional[UUID] = None
    solver: str = Field(default="hecras", description="hecras | telemac | anuga | educational_swe")
    solver_version: str = Field(default="1.0.0")
    description: Optional[str] = None


class ScenarioUpdate(BaseModel):
    """Update an existing draft scenario (only allowed when status='draft')."""
    variant: Optional[str] = None
    breach_params: Optional[Dict[str, Any]] = None
    dem_version_id: Optional[UUID] = None
    roughness_map_id: Optional[UUID] = None
    solver: Optional[str] = None
    solver_version: Optional[str] = None
    description: Optional[str] = None


# ── Response Schemas ──────────────────────────────────────────────────────────

class ScenarioResponse(BaseModel):
    """Scenario detail response."""
    id: UUID
    dam_id: UUID
    failure_mode: str
    variant: str
    breach_params: Dict[str, Any]
    dem_version_id: Optional[UUID] = None
    roughness_map_id: Optional[UUID] = None
    solver: str
    solver_version: str
    status: str
    approved_by: Optional[UUID] = None
    approved_at: Optional[datetime] = None
    description: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ScenarioListResponse(BaseModel):
    """Paginated scenario list."""
    total: int
    limit: int
    offset: int
    scenarios: List[ScenarioResponse]
