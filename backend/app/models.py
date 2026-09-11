"""
DamSafe Twin — SQLAlchemy ORM Models

Core tables for the dam-safe decision-support platform.
See architecture doc section 4 for the data model specification.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, CheckConstraint, Column, DateTime, Float, ForeignKey,
    Integer, String, Text, JSON, BigInteger, Enum as SAEnum
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from geoalchemy2 import Geometry

from app.database import Base


def generate_uuid():
    return uuid.uuid4()


# ── Users ────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    __table_args__ = (
        CheckConstraint(
            "role IN ('viewer','operator','analyst','approver','admin')",
            name="ck_users_role",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    keycloak_sub = Column(Text, unique=True, nullable=False)
    name = Column(Text, nullable=False)
    role = Column(Text, nullable=False)
    email = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    # relationships
    approved_scenarios = relationship("Scenario", back_populates="approver")
    approved_alerts = relationship("AlertDraft", back_populates="approver")


# ── Dams ─────────────────────────────────────────────────────────────────────

class Dam(Base):
    __tablename__ = "dams"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    name = Column(Text, nullable=False)
    location = Column(Geometry("POINT", srid=4326), nullable=False)
    dam_type = Column(Text)
    height_m = Column(Float)
    crest_length_m = Column(Float)
    spillway_count = Column(Integer)
    reservoir_capacity_mcm = Column(Float)
    metadata_ = Column("metadata", JSONB)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    # relationships
    scenarios = relationship("Scenario", back_populates="dam")
    dem_versions = relationship("DEMVersion", back_populates="dam")
    models_3d = relationship("Dam3DModel", back_populates="dam")


class Dam3DModel(Base):
    __tablename__ = "dam_3d_models"

    __table_args__ = (
        CheckConstraint(
            "source IN ('cad_import','photogrammetry','survey','procedural')",
            name="ck_dam_3d_models_source",
        ),
        CheckConstraint("format IN ('gltf','3d_tiles')", name="ck_dam_3d_models_format"),
        CheckConstraint(
            "status IN ('draft','reviewed','published')", name="ck_dam_3d_models_status"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    dam_id = Column(UUID(as_uuid=True), ForeignKey("dams.id"), nullable=False)
    source = Column(Text, nullable=False)
    format = Column(Text, nullable=False)
    lod_levels = Column(Integer, nullable=False, default=1)
    object_key = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="draft")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    dam = relationship("Dam", back_populates="models_3d")


# ── DEM Versions ─────────────────────────────────────────────────────────────

class DEMVersion(Base):
    __tablename__ = "dem_versions"

    __table_args__ = (
        CheckConstraint(
            "quality_grade IN ('prototype','planning_grade','engineering_reviewed','operationally_approved')",
            name="ck_dem_versions_quality_grade",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    dam_id = Column(UUID(as_uuid=True), ForeignKey("dams.id"), nullable=False)
    source = Column(Text, nullable=False)
    resolution_m = Column(Float, nullable=False)
    conditioning_steps = Column(JSONB, nullable=False)
    quality_grade = Column(Text, nullable=False)
    object_key = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    dam = relationship("Dam", back_populates="dem_versions")
    scenarios = relationship("Scenario", back_populates="dem_version")


# ── Roughness Maps ───────────────────────────────────────────────────────────

class RoughnessMap(Base):
    __tablename__ = "roughness_maps"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    dam_id = Column(UUID(as_uuid=True), ForeignKey("dams.id"), nullable=False)
    name = Column(Text, nullable=False)
    source = Column(Text)
    method = Column(Text)
    object_key = Column(Text, nullable=False)
    metadata_ = Column("metadata", JSONB)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    scenarios = relationship("Scenario", back_populates="roughness_map")


# ── Scenarios ────────────────────────────────────────────────────────────────

class Scenario(Base):
    __tablename__ = "scenarios"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    dam_id = Column(UUID(as_uuid=True), ForeignKey("dams.id"), nullable=False)
    failure_mode = Column(Text, nullable=False)
    variant = Column(Text, nullable=False)
    breach_params = Column(JSONB, nullable=False)
    dem_version_id = Column(UUID(as_uuid=True), ForeignKey("dem_versions.id"))
    roughness_map_id = Column(UUID(as_uuid=True), ForeignKey("roughness_maps.id"))
    solver = Column(Text, nullable=False)
    solver_version = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="draft")
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    # relationships
    dam = relationship("Dam", back_populates="scenarios")
    dem_version = relationship("DEMVersion", back_populates="scenarios")
    roughness_map = relationship("RoughnessMap", back_populates="scenarios")
    approver = relationship("User", back_populates="approved_scenarios")
    sim_runs = relationship("SimRun", back_populates="scenario")
    alert_drafts = relationship("AlertDraft", back_populates="scenario")

    __table_args__ = (
        CheckConstraint(
            "failure_mode IN ('piping','overtopping','controlled_release')",
            name="ck_scenarios_failure_mode",
        ),
        CheckConstraint(
            "status IN ('draft','submitted','approved','locked')",
            name="ck_scenarios_status",
        ),
        CheckConstraint(
            "status <> 'approved' OR approved_by IS NOT NULL",
            name="approval_requires_approver",
        ),
    )


# ── Simulation Runs ──────────────────────────────────────────────────────────

class SimRun(Base):
    __tablename__ = "sim_runs"

    __table_args__ = (
        CheckConstraint(
            "job_status IN ('queued','running','done','failed')",
            name="ck_sim_runs_job_status",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    scenario_id = Column(UUID(as_uuid=True), ForeignKey("scenarios.id"), nullable=False)
    job_status = Column(Text, nullable=False, default="queued")
    mass_balance_error = Column(Float)
    within_tolerance = Column(Boolean)
    result_layers = Column(JSONB, default={})
    started_at = Column(DateTime(timezone=True))
    finished_at = Column(DateTime(timezone=True))
    error_message = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    scenario = relationship("Scenario", back_populates="sim_runs")
    road_statuses = relationship("RoadStatus", back_populates="sim_run")
    evacuation_priorities = relationship("EvacuationPriority", back_populates="sim_run")
    alert_drafts = relationship("AlertDraft", back_populates="sim_run")


# ── Exposure / At-Risk Data ──────────────────────────────────────────────────

class Village(Base):
    __tablename__ = "villages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    name = Column(Text, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)
    population = Column(Integer)
    district = Column(Text)
    block = Column(Text)
    metadata_ = Column("metadata", JSONB)


class Facility(Base):
    __tablename__ = "facilities"

    __table_args__ = (
        CheckConstraint(
            "kind IN ('hospital','school','substation','telecom_tower','police_station')",
            name="ck_facilities_kind",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    name = Column(Text)
    kind = Column(Text)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)
    metadata_ = Column("metadata", JSONB)


class Road(Base):
    __tablename__ = "roads"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    name = Column(Text)
    geom = Column(Geometry("LINESTRING", srid=4326), nullable=False)
    osm_id = Column(BigInteger)
    road_class = Column(Text)
    surface = Column(Text)


class Shelter(Base):
    __tablename__ = "shelters"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    name = Column(Text, nullable=False)
    geom = Column(Geometry("POINT", srid=4326), nullable=False)
    capacity = Column(Integer)
    shelter_type = Column(Text)
    metadata_ = Column("metadata", JSONB)


# ── Impact Analysis ──────────────────────────────────────────────────────────

class RoadStatus(Base):
    __tablename__ = "road_status"

    __table_args__ = (
        CheckConstraint(
            "status IN ('safe','restricted','impassable')",
            name="ck_road_status_status",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    sim_run_id = Column(UUID(as_uuid=True), ForeignKey("sim_runs.id"), nullable=False)
    road_id = Column(UUID(as_uuid=True), ForeignKey("roads.id"), nullable=False)
    t_minutes = Column(Integer, nullable=False)
    status = Column(Text, nullable=False)

    sim_run = relationship("SimRun", back_populates="road_statuses")
    road = relationship("Road")


class EvacuationPriority(Base):
    __tablename__ = "evacuation_priority"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    sim_run_id = Column(UUID(as_uuid=True), ForeignKey("sim_runs.id"), nullable=False)
    village_id = Column(UUID(as_uuid=True), ForeignKey("villages.id"), nullable=False)
    exposure = Column(Float)
    hazard = Column(Float)
    vulnerability = Column(Float)
    arrival_time_min = Column(Float)
    warning_time_min = Column(Float)
    mobilize_time_min = Column(Float)
    priority_score = Column(Float, nullable=False)

    sim_run = relationship("SimRun", back_populates="evacuation_priorities")
    village = relationship("Village")


# ── Alerts ───────────────────────────────────────────────────────────────────

class AlertDraft(Base):
    __tablename__ = "alert_drafts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=generate_uuid)
    sim_run_id = Column(UUID(as_uuid=True), ForeignKey("sim_runs.id"), nullable=False)
    scenario_id = Column(UUID(as_uuid=True), ForeignKey("scenarios.id"), nullable=False)
    content = Column(Text, nullable=False)
    language = Column(Text, nullable=False)
    severity = Column(Text)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    dispatched_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    sim_run = relationship("SimRun", back_populates="alert_drafts")
    scenario = relationship("Scenario", back_populates="alert_drafts")
    approver = relationship("User", back_populates="approved_alerts")

    __table_args__ = (
        CheckConstraint("language IN ('en','hi')", name="ck_alert_drafts_language"),
        CheckConstraint(
            "severity IN ('watch','warning','emergency')",
            name="ck_alert_drafts_severity",
        ),
        CheckConstraint(
            "dispatched_at IS NULL OR approved_by IS NOT NULL",
            name="dispatch_requires_approval",
        ),
    )


# ── Audit Log ────────────────────────────────────────────────────────────────

class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    actor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    action = Column(Text, nullable=False)
    entity = Column(Text, nullable=False)
    entity_id = Column(UUID(as_uuid=True))
    diff = Column(JSONB)
    at = Column(DateTime(timezone=True), default=datetime.utcnow)
