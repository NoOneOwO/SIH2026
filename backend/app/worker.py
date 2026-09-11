"""
DamSafe Twin — Celery Worker

Task definitions for simulation orchestration, DEM conditioning, and 3D model building.
"""

import json
import traceback
from datetime import datetime
from typing import Optional

from celery import Celery
from celery.schedules import crontab

from app.config import get_settings

settings = get_settings()

# ── Celery App ────────────────────────────────────────────────────────────────

celery_app = Celery(
    "damsafe",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=settings.SOLVER_TIMEOUT_SECONDS,
    task_time_limit=settings.SOLVER_TIMEOUT_SECONDS + 300,
    beat_schedule={
        "health-check": {
            "task": "app.worker.health_check",
            "schedule": 60.0,  # every minute
        },
    },
)


# ── Tasks ─────────────────────────────────────────────────────────────────────

@celery_app.task(name="app.worker.health_check", bind=True)
def health_check(self):
    """Periodic health check task."""
    return {"status": "healthy", "worker": self.request.id, "timestamp": datetime.utcnow().isoformat()}


@celery_app.task(name="app.worker.run_solver_task", bind=True, max_retries=2)
def run_solver_task(self, sim_run_id: str, scenario_id: str, solver: str, breach_params: dict):
    """
    Main solver task — orchestrates the hydrodynamic simulation.

    In production, this dispatches to the actual solver (HEC-RAS/ANUGA).
    For MVP, runs the educational SWE solver or returns mock results.
    """
    import asyncio
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    engine = create_engine(settings.sync_database_url)

    try:
        # Update status to running
        with Session(engine) as db:
            from app.models import SimRun
            sim_run = db.get(SimRun, sim_run_id)
            if sim_run:
                sim_run.job_status = "running"
                sim_run.started_at = datetime.utcnow()
                db.commit()

        # Dispatch to solver
        if solver == "educational_swe":
            result = _run_educational_swe(scenario_id, breach_params)
        elif solver == "hecras":
            result = _run_hecras_adapter(scenario_id, breach_params)
        elif solver == "anuga":
            result = _run_anuga_adapter(scenario_id, breach_params)
        else:
            result = _run_educational_swe(scenario_id, breach_params)

        # Check mass balance
        mass_balance_error = result.get("mass_balance_error", 0.0)
        within_tolerance = mass_balance_error <= settings.MASS_BALANCE_TOLERANCE_PCT

        # Update status to done
        with Session(engine) as db:
            from app.models import SimRun
            sim_run = db.get(SimRun, sim_run_id)
            if sim_run:
                sim_run.job_status = "done"
                sim_run.finished_at = datetime.utcnow()
                sim_run.result_layers = result.get("result_layers", {})
                sim_run.mass_balance_error = mass_balance_error
                sim_run.within_tolerance = within_tolerance
                db.commit()

        return {
            "sim_run_id": sim_run_id,
            "status": "done",
            "mass_balance_error": mass_balance_error,
            "within_tolerance": within_tolerance,
        }

    except Exception as e:
        # Update status to failed
        with Session(engine) as db:
            from app.models import SimRun
            sim_run = db.get(SimRun, sim_run_id)
            if sim_run:
                sim_run.job_status = "failed"
                sim_run.finished_at = datetime.utcnow()
                sim_run.error_message = f"{str(e)}\n{traceback.format_exc()}"
                db.commit()

        # Retry on transient failures
        raise self.retry(exc=e, countdown=60)


@celery_app.task(name="app.worker.condition_dem_task", bind=True)
def condition_dem_task(self, dem_id: str, steps: list):
    """
    DEM conditioning pipeline: sink fill, breaklines, channel burn.
    Runs as a background Celery job.
    """
    # In production: uses WhiteboxTools / GDAL
    # For MVP: logs the steps and returns
    return {
        "dem_id": dem_id,
        "status": "completed",
        "steps_applied": steps,
        "quality_grade": "planning_grade",
        "message": "DEM conditioning completed (MVP stub)",
    }


@celery_app.task(name="app.worker.build_dam_model_task", bind=True)
def build_dam_model_task(self, dam_id: str, source_type: str = "procedural"):
    """
    Build a 3D dam model (procedural or from CAD).
    Path B: procedural fallback using trimesh.
    """
    return {
        "dam_id": dam_id,
        "source_type": source_type,
        "status": "completed",
        "object_key": f"3d-models/{dam_id}/dam.glb",
        "format": "gltf",
        "message": "3D dam model built (MVP stub)",
    }


# ── Solver Adapters ──────────────────────────────────────────────────────────

def _run_educational_swe(scenario_id: str, breach_params: dict) -> dict:
    """
    Educational 2D SWE solver (labeled research/rapid-viz module).

    This is the simplified shallow-water equation solver for demonstration.
    NOT intended for operational use.
    """
    import numpy as np

    # Simple 1D dam-break analytical solution (Ritter solution) for demonstration
    # h(x,t) = (1/9g) * (2*sqrt(g*h0) - x/t)^2 for x/t < 2*sqrt(g*h0)
    h0 = breach_params.get("breach_depth_m", 10.0)
    g = 9.81

    # Generate representative result layers (mock 2D grids)
    grid_size = 100
    extent = np.zeros((grid_size, grid_size))
    depth = np.zeros((grid_size, grid_size))
    velocity = np.zeros((grid_size, grid_size))
    arrival_time = np.full((grid_size, grid_size), np.inf)

    # Simple downstream propagation
    for i in range(grid_size):
        for j in range(grid_size):
            x = i * 10  # 10m cells
            t = 60  # 1 minute
            if x < 2 * np.sqrt(g * h0) * t:
                h_val = (1 / (9 * g)) * (2 * np.sqrt(g * h0) - x / max(t, 1)) ** 2
                depth[i, j] = max(0, h_val)
                velocity[i, j] = 2 * np.sqrt(g * max(0, h_val)) / 3 if h_val > 0.01 else 0
                arrival_time[i, j] = x / (2 * np.sqrt(g * h0)) if x > 0 else 0
                extent[i, j] = 1 if depth[i, j] > 0.01 else 0

    # Compute mass balance
    total_in = h0 * grid_size * 10  # initial volume estimate
    total_out = float(np.sum(depth)) * 10 * 10  # volume at t
    mass_balance_error = abs(total_in - total_out) / max(total_in, 1e-10) * 100

    # Hazard index
    hazard = depth * np.sqrt(velocity ** 2)

    return {
        "result_layers": {
            "extent": f"results/{scenario_id}/extent.tif",
            "depth": f"results/{scenario_id}/depth.tif",
            "velocity": f"results/{scenario_id}/velocity.tif",
            "arrival_time": f"results/{scenario_id}/arrival_time.tif",
            "hazard": f"results/{scenario_id}/hazard.tif",
        },
        "mass_balance_error": round(mass_balance_error, 4),
        "grid_size": grid_size,
        "cell_size_m": 10,
        "solver": "educational_swe",
        "solver_version": "1.0.0-mvp",
    }


def _run_hecras_adapter(scenario_id: str, breach_params: dict) -> dict:
    """
    HEC-RAS adapter stub.

    In production: uses HEC-RAS Controller / CLI to run the 2D unsteady flow simulation.
    For MVP: returns mock results.
    """
    return {
        "result_layers": {
            "extent": f"results/{scenario_id}/hecras_extent.tif",
            "depth": f"results/{scenario_id}/hecras_depth.tif",
            "velocity": f"results/{scenario_id}/hecras_velocity.tif",
            "arrival_time": f"results/{scenario_id}/hecras_arrival_time.tif",
            "hazard": f"results/{scenario_id}/hecras_hazard.tif",
        },
        "mass_balance_error": 0.5,
        "solver": "hecras",
        "solver_version": "6.5.0",
    }


def _run_anuga_adapter(scenario_id: str, breach_params: dict) -> dict:
    """
    ANUGA adapter stub.

    In production: uses ANUGA Python API for 2D SWE simulation.
    For MVP: returns mock results.
    """
    return {
        "result_layers": {
            "extent": f"results/{scenario_id}/anuga_extent.tif",
            "depth": f"results/{scenario_id}/anuga_depth.tif",
            "velocity": f"results/{scenario_id}/anuga_velocity.tif",
            "arrival_time": f"results/{scenario_id}/anuga_arrival_time.tif",
            "hazard": f"results/{scenario_id}/anuga_hazard.tif",
        },
        "mass_balance_error": 0.3,
        "solver": "anuga",
        "solver_version": "2.0.5",
    }
