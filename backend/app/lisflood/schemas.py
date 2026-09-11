"""DamSafe Twin — LISFLOOD-FP scenario request schemas.

Server-side validation for every simulation parameter. Nothing from the
frontend reaches a shell: the runner only ever consumes these validated
values to render fixed-format ASCII input files.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

FailureMode = Literal["overtopping", "piping", "controlled_release"]


class LisfloodRunRequest(BaseModel):
    """Scenario parameters for a real LISFLOOD-FP dam-break run.

    All values are illustrative/demo parameters for a decision-support
    prototype — NOT validated engineering values.
    """

    dam_id: str = Field(..., min_length=1, max_length=32, description="Canonical dam id (e.g. d16)")

    failure_mode: FailureMode = Field(
        "overtopping",
        description="Breach trigger narrative; recorded in metadata. "
        "v1 weir is static (instantaneous breach) — see limitations doc.",
    )

    reservoir_level_m: float | None = Field(
        None,
        description="Reservoir water-surface elevation (m, same vertical datum as DEM). "
        "Omitted -> illustrative default (dam-cell elevation + 12 m).",
    )
    breach_width_m: float = Field(80.0, gt=0, le=2000)
    breach_depth_m: float = Field(20.0, gt=0, le=300)
    breach_formation_time_min: float = Field(
        45.0,
        ge=0,
        le=1440,
        description="Accepted, validated and stored. v1 limitation: the LISFLOOD "
        "weir is static, so formation dynamics are instantaneous. "
        "Reserved for future time-varying breach support.",
    )

    duration_min: float = Field(120.0, gt=0, le=1440, description="Simulation duration (minutes)")
    mannings_n: float = Field(0.035, gt=0.005, le=0.3, description="Floodplain Manning's n")
    domain_radius_km: float = Field(2.0, gt=0.2, le=5.0, description="Half-width of square domain around dam")
    cell_size_m: float = Field(30.0, ge=10.0, le=120.0, description="Metric resampling of source DEM")
    timeout_s: float = Field(1800.0, gt=60, le=7200, description="Engine wall-clock cap (seconds)")

    @field_validator("dam_id")
    @classmethod
    def _dam_id_safe(cls, v: str) -> str:
        if not v.replace("_", "").replace("-", "").isalnum():
            raise ValueError("dam_id must be alphanumeric")
        return v
