"""Initial schema — all core tables

Revision ID: 001_initial
Revises: None
Create Date: 2026-08-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from geoalchemy2 import Geometry

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Enable PostGIS extension
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    # ── Users ────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("keycloak_sub", sa.Text, unique=True, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("email", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── Dams ─────────────────────────────────────────────────────────────────
    op.create_table(
        "dams",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("location", Geometry("POINT", srid=4326), nullable=False),
        sa.Column("dam_type", sa.Text),
        sa.Column("height_m", sa.Float),
        sa.Column("crest_length_m", sa.Float),
        sa.Column("spillway_count", sa.Integer),
        sa.Column("reservoir_capacity_mcm", sa.Float),
        sa.Column("metadata", postgresql.JSONB),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("idx_dams_location", "dams", ["location"], postgresql_using="gist")

    # ── 3D Dam Models ────────────────────────────────────────────────────────
    op.create_table(
        "dam_3d_models",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("dam_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dams.id"), nullable=False),
        sa.Column("source", sa.Text, nullable=False),
        sa.Column("format", sa.Text, nullable=False),
        sa.Column("lod_levels", sa.Integer, nullable=False, server_default="1"),
        sa.Column("object_key", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── DEM Versions ─────────────────────────────────────────────────────────
    op.create_table(
        "dem_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("dam_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dams.id"), nullable=False),
        sa.Column("source", sa.Text, nullable=False),
        sa.Column("resolution_m", sa.Float, nullable=False),
        sa.Column("conditioning_steps", postgresql.JSONB, nullable=False),
        sa.Column("quality_grade", sa.Text, nullable=False),
        sa.Column("object_key", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── Roughness Maps ───────────────────────────────────────────────────────
    op.create_table(
        "roughness_maps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("dam_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dams.id"), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("source", sa.Text),
        sa.Column("method", sa.Text),
        sa.Column("object_key", sa.Text, nullable=False),
        sa.Column("metadata", postgresql.JSONB),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── Scenarios ────────────────────────────────────────────────────────────
    op.create_table(
        "scenarios",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("dam_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dams.id"), nullable=False),
        sa.Column("failure_mode", sa.Text, nullable=False),
        sa.Column("variant", sa.Text, nullable=False),
        sa.Column("breach_params", postgresql.JSONB, nullable=False),
        sa.Column("dem_version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dem_versions.id")),
        sa.Column("roughness_map_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("roughness_maps.id")),
        sa.Column("solver", sa.Text, nullable=False),
        sa.Column("solver_version", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="draft"),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("description", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("status <> 'approved' OR approved_by IS NOT NULL", name="approval_requires_approver"),
    )

    # ── Simulation Runs ──────────────────────────────────────────────────────
    op.create_table(
        "sim_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("scenario_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("scenarios.id"), nullable=False),
        sa.Column("job_status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("mass_balance_error", sa.Float),
        sa.Column("within_tolerance", sa.Boolean),
        sa.Column("result_layers", postgresql.JSONB, server_default="{}"),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("error_message", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── Villages ─────────────────────────────────────────────────────────────
    op.create_table(
        "villages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("geom", Geometry("POINT", srid=4326), nullable=False),
        sa.Column("population", sa.Integer),
        sa.Column("district", sa.Text),
        sa.Column("block", sa.Text),
        sa.Column("metadata", postgresql.JSONB),
    )
    op.create_index("idx_villages_geom", "villages", ["geom"], postgresql_using="gist")

    # ── Facilities ───────────────────────────────────────────────────────────
    op.create_table(
        "facilities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text),
        sa.Column("kind", sa.Text),
        sa.Column("geom", Geometry("POINT", srid=4326), nullable=False),
        sa.Column("metadata", postgresql.JSONB),
    )
    op.create_index("idx_facilities_geom", "facilities", ["geom"], postgresql_using="gist")

    # ── Roads ────────────────────────────────────────────────────────────────
    op.create_table(
        "roads",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text),
        sa.Column("geom", Geometry("LINESTRING", srid=4326), nullable=False),
        sa.Column("osm_id", sa.BigInteger),
        sa.Column("road_class", sa.Text),
        sa.Column("surface", sa.Text),
    )
    op.create_index("idx_roads_geom", "roads", ["geom"], postgresql_using="gist")

    # ── Shelters ─────────────────────────────────────────────────────────────
    op.create_table(
        "shelters",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("geom", Geometry("POINT", srid=4326), nullable=False),
        sa.Column("capacity", sa.Integer),
        sa.Column("shelter_type", sa.Text),
        sa.Column("metadata", postgresql.JSONB),
    )
    op.create_index("idx_shelters_geom", "shelters", ["geom"], postgresql_using="gist")

    # ── Road Status ──────────────────────────────────────────────────────────
    op.create_table(
        "road_status",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("sim_run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sim_runs.id"), nullable=False),
        sa.Column("road_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("roads.id"), nullable=False),
        sa.Column("t_minutes", sa.Integer, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
    )

    # ── Evacuation Priority ──────────────────────────────────────────────────
    op.create_table(
        "evacuation_priority",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("sim_run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sim_runs.id"), nullable=False),
        sa.Column("village_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("villages.id"), nullable=False),
        sa.Column("exposure", sa.Float),
        sa.Column("hazard", sa.Float),
        sa.Column("vulnerability", sa.Float),
        sa.Column("arrival_time_min", sa.Float),
        sa.Column("warning_time_min", sa.Float),
        sa.Column("mobilize_time_min", sa.Float),
        sa.Column("priority_score", sa.Float, nullable=False),
    )

    # ── Alert Drafts ─────────────────────────────────────────────────────────
    op.create_table(
        "alert_drafts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("sim_run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sim_runs.id"), nullable=False),
        sa.Column("scenario_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("scenarios.id"), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("language", sa.Text, nullable=False),
        sa.Column("severity", sa.Text),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("dispatched_at IS NULL OR approved_by IS NOT NULL", name="dispatch_requires_approval"),
    )

    # ── Audit Log ────────────────────────────────────────────────────────────
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("entity", sa.Text, nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True)),
        sa.Column("diff", postgresql.JSONB),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("idx_audit_log_at", "audit_log", ["at"])
    op.create_index("idx_audit_log_entity", "audit_log", ["entity", "entity_id"])


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("alert_drafts")
    op.drop_table("evacuation_priority")
    op.drop_table("road_status")
    op.drop_table("shelters")
    op.drop_table("roads")
    op.drop_table("facilities")
    op.drop_table("villages")
    op.drop_table("sim_runs")
    op.drop_table("scenarios")
    op.drop_table("roughness_maps")
    op.drop_table("dem_versions")
    op.drop_table("dam_3d_models")
    op.drop_table("dams")
    op.drop_table("users")
    op.execute("DROP EXTENSION IF EXISTS postgis")
