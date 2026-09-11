"""
DamSafe Twin — Database Initialization

Run migrations + seed demo data for the chosen case-study dam.
Usage: python -m init_db
"""

import asyncio
import uuid
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import engine, async_session_factory, Base
from app.config import get_settings
from app.models import (
    User, Dam, DEMVersion, RoughnessMap, Scenario, SimRun,
    Village, Facility, Road, Shelter,
)

settings = get_settings()

# ── Demo Seed Data ────────────────────────────────────────────────────────────

DEMO_USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")
DEMO_DAM_ID = uuid.UUID("10000000-0000-0000-0000-000000000001")
DEMO_DEM_ID = uuid.UUID("20000000-0000-0000-0000-000000000001")
DEMO_ROUGHNESS_ID = uuid.UUID("30000000-0000-0000-0000-000000000001")

# Case-study: Use a representative Indian dam (e.g., similar to Machhu Dam, Morbi)
DEMO_DAM = {
    "id": DEMO_DAM_ID,
    "name": "Machhu Dam (Demo — Morbi, Gujarat)",
    "location": "SRID=4326;POINT(70.85 22.83)",
    "dam_type": "earthen_embankment",
    "height_m": 35.0,
    "crest_length_m": 1600.0,
    "spillway_count": 2,
    "reservoir_capacity_mcm": 120.0,
}

DEMO_VILLAGES = [
    {"name": "Morbi City", "geom": "SRID=4326;POINT(70.83 22.82)", "population": 210000, "district": "Morbi"},
    {"name": "Tankara", "geom": "SRID=4326;POINT(70.78 22.80)", "population": 15000, "district": "Morbi"},
    {"name": "Wankaner", "geom": "SRID=4326;POINT(70.95 22.85)", "population": 30000, "district": "Morbi"},
    {"name": "Halvad", "geom": "SRID=4326;POINT(71.18 23.02)", "population": 25000, "district": "Morbi"},
    {"name": "Muli", "geom": "SRID=4326;POINT(71.05 22.75)", "population": 12000, "district": "Morbi"},
    {"name": "Bhalbhal", "geom": "SRID=4326;POINT(70.82 22.78)", "population": 5000, "district": "Morbi"},
    {"name": "Jhinjhuwa", "geom": "SRID=4326;POINT(70.75 22.85)", "population": 3500, "district": "Morbi"},
    {"name": "Makkerha", "geom": "SRID=4326;POINT(70.90 22.70)", "population": 4200, "district": "Morbi"},
]

DEMO_FACILITIES = [
    {"name": "Morbi General Hospital", "kind": "hospital", "geom": "SRID=4326;POINT(70.83 22.82)"},
    {"name": "Morbi Police Station", "kind": "police_station", "geom": "SRID=4326;POINT(70.84 22.81)"},
    {"name": "GEB Substation Morbi", "kind": "substation", "geom": "SRID=4326;POINT(70.82 22.83)"},
    {"name": "BSNL Tower Morbi", "kind": "telecom_tower", "geom": "SRID=4326;POINT(70.85 22.82)"},
    {"name": "Government School Tankara", "kind": "school", "geom": "SRID=4326;POINT(70.78 22.80)"},
]

DEMO_ROADS = [
    {"name": "NH-27 (Morbi-Rajkot)", "geom": "SRID=4326;LINESTRING(70.70 22.82, 70.83 22.82, 71.00 22.83)", "road_class": "national_highway"},
    {"name": "SH-6 (Morbi-Tankara)", "geom": "SRID=4326;LINESTRING(70.83 22.82, 70.78 22.80, 70.75 22.78)", "road_class": "state_highway"},
    {"name": "Morbi-Wankaner Road", "geom": "SRID=4326;LINESTRING(70.83 22.82, 70.90 22.84, 70.95 22.85)", "road_class": "district_road"},
]

DEMO_SCENARIOS = [
    {
        "id": uuid.UUID("40000000-0000-0000-0000-000000000001"),
        "failure_mode": "overtopping",
        "variant": "expected",
        "breach_params": {
            "breach_width_m": 150,
            "breach_depth_m": 25,
            "formation_time_hr": 0.5,
            "method": "froehlich_2008",
            "note": "Froehlich-derived; generator, not truth",
        },
        "solver": "educational_swe",
        "solver_version": "1.0.0-mvp",
    },
    {
        "id": uuid.UUID("40000000-0000-0000-0000-000000000002"),
        "failure_mode": "piping",
        "variant": "conservative",
        "breach_params": {
            "breach_width_m": 80,
            "breach_depth_m": 30,
            "formation_time_hr": 1.0,
            "method": "froehlich_2008",
            "note": "Conservative piping scenario",
        },
        "solver": "educational_swe",
        "solver_version": "1.0.0-mvp",
    },
]


async def seed_data():
    """Seed demo data into the database."""
    async with async_session_factory() as db:
        try:
            # Check if data already exists
            result = await db.execute(text("SELECT COUNT(*) FROM dams"))
            count = result.scalar()
            if count > 0:
                print("Database already seeded. Skipping.")
                return

            # ── Demo User ────────────────────────────────────────────────
            user = User(
                id=DEMO_USER_ID,
                keycloak_sub="dev-user",
                name="Demo Operator",
                role="admin",
                email="demo@damsafe.local",
            )
            db.add(user)

            # ── Demo Dam ────────────────────────────────────────────────
            dam = Dam(
                id=DEMO_DAM_ID,
                name=DEMO_DAM["name"],
                dam_type=DEMO_DAM["dam_type"],
                height_m=DEMO_DAM["height_m"],
                crest_length_m=DEMO_DAM["crest_length_m"],
                spillway_count=DEMO_DAM["spillway_count"],
                reservoir_capacity_mcm=DEMO_DAM["reservoir_capacity_mcm"],
            )
            dam.location = DEMO_DAM["location"]
            db.add(dam)

            # ── DEM Version ─────────────────────────────────────────────
            dem = DEMVersion(
                id=DEMO_DEM_ID,
                dam_id=DEMO_DAM_ID,
                source="CartoDEM",
                resolution_m=30.0,
                conditioning_steps={"sink_fill": True, "breaklines": False, "channel_burn": True},
                quality_grade="prototype",
                object_key="dem/machhu/cartodem_30m.tif",
            )
            db.add(dem)

            # ── Roughness Map ───────────────────────────────────────────
            rm = RoughnessMap(
                id=DEMO_ROUGHNESS_ID,
                dam_id=DEMO_DAM_ID,
                name="LULC-based Manning's n",
                source="LULC Map",
                method="standard_lulc_to_mannings",
                object_key="roughness/machhu/mannings_n.tif",
            )
            db.add(rm)

            # ── Villages ────────────────────────────────────────────────
            for v_data in DEMO_VILLAGES:
                village = Village(
                    id=uuid.uuid4(),
                    name=v_data["name"],
                    population=v_data["population"],
                    district=v_data["district"],
                )
                village.geom = v_data["geom"]
                db.add(village)

            # ── Facilities ──────────────────────────────────────────────
            for f_data in DEMO_FACILITIES:
                facility = Facility(
                    id=uuid.uuid4(),
                    name=f_data["name"],
                    kind=f_data["kind"],
                )
                facility.geom = f_data["geom"]
                db.add(facility)

            # ── Roads ───────────────────────────────────────────────────
            for r_data in DEMO_ROADS:
                road = Road(
                    id=uuid.uuid4(),
                    name=r_data["name"],
                    road_class=r_data["road_class"],
                )
                road.geom = r_data["geom"]
                db.add(road)

            # ── Demo Scenarios ──────────────────────────────────────────
            for s_data in DEMO_SCENARIOS:
                scenario = Scenario(
                    id=s_data["id"],
                    dam_id=DEMO_DAM_ID,
                    failure_mode=s_data["failure_mode"],
                    variant=s_data["variant"],
                    breach_params=s_data["breach_params"],
                    dem_version_id=DEMO_DEM_ID,
                    roughness_map_id=DEMO_ROUGHNESS_ID,
                    solver=s_data["solver"],
                    solver_version=s_data["solver_version"],
                    status="approved",
                    approved_by=DEMO_USER_ID,
                    approved_at=datetime.utcnow(),
                )
                db.add(scenario)

            await db.commit()
            print("✅ Demo data seeded successfully!")
            print(f"   - 1 dam: {DEMO_DAM['name']}")
            print(f"   - {len(DEMO_VILLAGES)} villages")
            print(f"   - {len(DEMO_FACILITIES)} facilities")
            print(f"   - {len(DEMO_ROADS)} roads")
            print(f"   - {len(DEMO_SCENARIOS)} scenarios (overtopping + piping)")
            print(f"   - 1 admin user (dev-user)")

        except Exception as e:
            await db.rollback()
            print(f"❌ Error seeding data: {e}")
            raise


async def create_tables():
    """Create all tables (alternative to Alembic for quick setup)."""
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.run_sync(Base.metadata.create_all)
    print("✅ Tables created successfully!")


async def main():
    print("🛡️  DamSafe Twin — Database Initialization")
    print("=" * 50)

    print("\n1. Creating tables...")
    await create_tables()

    print("\n2. Seeding demo data...")
    await seed_data()

    print("\n✅ Initialization complete!")


if __name__ == "__main__":
    asyncio.run(main())
