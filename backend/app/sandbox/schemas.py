"""
DamSafe Twin Sandbox — scenario data model (validated at the API boundary).
"""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ScenarioParams(BaseModel):
    """One counterfactual breach scenario. Parameters ONLY — never outcomes."""

    dam_id: str = Field(..., description="Terrain site id, e.g. 'd4'")
    label: str = Field(default="custom", description="best | likely | worst | custom | ensemble-i")
    reservoir_level_m: float = Field(..., ge=0, le=10000, description="Reservoir water surface elevation (m)")
    breach_location: str = Field(default="dam", description="'dam' (site center) or 'r,c' grid cell")
    breach_width_m: float = Field(..., gt=0, le=2000)
    breach_depth_m: float = Field(..., gt=0, le=500)
    breach_severity: Literal["partial", "major", "full"] = "major"
    initial_release_m3: float = Field(..., gt=0, le=5e9, description="Flood volume released over the first 30 sim-minutes (m³)")
    roughness: float = Field(default=0.05, gt=0.005, le=0.5, description="Manning-style n (higher = more friction)")
    rainfall_factor: float = Field(default=1.0, ge=0, le=5, description="Multiplier on 20 mm/h design storm")
    duration_min: float = Field(default=120, gt=0, le=1440)
    timestep_s: float = Field(default=60, ge=5, le=600)
    seed: int = Field(default=7, ge=0, description="Deterministic seed (rainfall jitter)")
    breach_formation_min: Optional[float] = Field(
        default=None, gt=0, le=1440,
        description="Breach growth time (min). None = severity default (90/45/20).")


class GenerateRequest(BaseModel):
    dam_id: str
    seed: int = 7
    ensemble_count: int = Field(default=10, ge=2, le=100)


class RunRequest(BaseModel):
    dam_id: str
    scenario: ScenarioParams
    grid_size: int = Field(default=96, ge=32, le=256, description="Sim grid (visual mesh stays hi-res)")
    seed: Optional[int] = None


class EnsembleRequest(BaseModel):
    dam_id: str
    count: int = Field(default=10, ge=2, le=100)
    seed: int = 7
    grid_size: int = Field(default=64, ge=32, le=128)
    base: Optional[ScenarioParams] = None


class AssetExposure(BaseModel):
    name: str
    kind: str
    lon: float
    lat: float
    source: str = Field(description="'osm' (OpenStreetMap) or 'modeled' (documented sample point, NOT a real asset)")
    arrival_min: Optional[float] = None
    max_depth_m: float = 0.0
    severity: int = 0
    exposure_pct: Optional[float] = None
    priority: int = 0
