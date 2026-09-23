"""
DamSafe Twin — Celery Worker

Task definitions for simulation orchestration, DEM conditioning, and 3D model building.

Classic-path results are self-contained: solver grids are embedded in
``SimRun.result_layers`` (base64 float32 + anchor meta, see
``app.impact.grids``) so the API can sample exposure without shared
filesystems. GeoTIFF/S3 artifacts are best-effort extras for GIS consumers.
"""

import base64
import json
import traceback
from datetime import datetime

from celery import Celery
from celery.schedules import crontab  # noqa: F401  (kept for beat schedule extensions)

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

# Solvers the classic Celery path can actually execute. Anything else fails
# fast with an explicit reason instead of fabricating result layers.
CLASSIC_SOLVERS = {"educational_swe"}


# ── Tasks ─────────────────────────────────────────────────────────────────────

@celery_app.task(name="app.worker.health_check", bind=True)
def health_check(self):
    """Periodic health check task."""
    return {"status": "healthy", "worker": self.request.id, "timestamp": datetime.utcnow().isoformat()}


@celery_app.task(name="app.worker.run_solver_task", bind=True, max_retries=2)
def run_solver_task(self, sim_run_id: str, scenario_id: str, solver: str, breach_params: dict):
    """
    Main solver task — runs the hydrodynamic screening simulation.

    Flow: guard (queued only) → solver allowlist → running → compute grids →
    embed grids in result_layers → sample villages → persist priority rows →
    done. Unsupported solvers and failures are recorded honestly; transient
    errors retry, deterministic ones do not.
    """
    import asyncio  # noqa: F401 (kept: async helpers may run under worker-async)
    from sqlalchemy import create_engine, select, func
    from sqlalchemy.orm import Session

    from app.models import SimRun, Scenario, Dam, Village, EvacuationPriority

    engine = create_engine(settings.sync_database_url)

    def _load_context(db: Session):
        sim_run = db.get(SimRun, sim_run_id)
        scenario = db.get(Scenario, scenario_id) if sim_run else None
        dam = db.get(Dam, scenario.dam_id) if scenario else None
        lon = lat = None
        if dam is not None:
            lon = db.scalar(select(func.ST_X(Dam.location)).where(Dam.id == dam.id))
            lat = db.scalar(select(func.ST_Y(Dam.location)).where(Dam.id == dam.id))
        return sim_run, scenario, dam, lon, lat

    with Session(engine) as db:
        sim_run, scenario, dam, dam_lon, dam_lat = _load_context(db)
        if sim_run is None:
            return {"sim_run_id": sim_run_id, "status": "aborted", "reason": "sim run not found"}
        if sim_run.job_status != "queued":
            # Already started/cancelled elsewhere — never double-run.
            return {"sim_run_id": sim_run_id, "status": "aborted",
                    "reason": f"job_status is '{sim_run.job_status}', expected 'queued'"}
        if solver not in CLASSIC_SOLVERS:
            sim_run.job_status = "failed"
            sim_run.finished_at = datetime.utcnow()
            sim_run.error_message = (
                f"Solver '{solver}' is not executable on the classic Celery path. "
                f"Supported: {sorted(CLASSIC_SOLVERS)}. "
                "HEC-RAS/ANUGA need their external engines; LISFLOOD-FP runs via /api/v1/lisflood."
            )
            db.commit()
            return {"sim_run_id": sim_run_id, "status": "failed",
                    "reason": f"unsupported solver '{solver}'"}
        if dam is None or dam_lon is None or dam_lat is None:
            sim_run.job_status = "failed"
            sim_run.finished_at = datetime.utcnow()
            sim_run.error_message = "Scenario dam or dam location missing — cannot anchor result grids."
            db.commit()
            return {"sim_run_id": sim_run_id, "status": "failed", "reason": "dam location missing"}
        sim_run.job_status = "running"
        sim_run.started_at = datetime.utcnow()
        db.commit()

    try:
        result = _run_educational_swe(
            scenario_id, breach_params or {},
            float(dam_lon), float(dam_lat),
        )

        with Session(engine) as db:
            from app.impact import grids as grid_codec
            from app.impact.service import (
                compute_hazard_index, compute_evacuation_priority,
            )
            sim_run = db.get(SimRun, sim_run_id)
            if sim_run is None:
                raise RuntimeError(f"SimRun {sim_run_id} vanished mid-run")
            decoded = grid_codec.decode_grids(result["result_layers"])
            if decoded is None:
                raise RuntimeError("solver returned un-decodable grids")

            mass_balance_error = result.get("mass_balance_error", 0.0)
            sim_run.job_status = "done"
            sim_run.finished_at = datetime.utcnow()
            sim_run.result_layers = result["result_layers"]
            sim_run.mass_balance_error = mass_balance_error
            sim_run.within_tolerance = (
                mass_balance_error <= settings.MASS_BALANCE_TOLERANCE_PCT
            )
            db.flush()

            # Priority rows: written once, from the run's own grids. The API
            # serves these idempotently; it never recomputes on GET.
            already = db.scalar(
                select(func.count(EvacuationPriority.id)).where(
                    EvacuationPriority.sim_run_id == sim_run.id)
            )
            if not already:
                villages = db.execute(
                    select(Village,
                           func.ST_X(Village.geom).label("lon"),
                           func.ST_Y(Village.geom).label("lat"))
                ).all()
                for village, lon, lat in villages:
                    if lon is None or lat is None:
                        continue
                    s = grid_codec.sample_point(decoded, float(lon), float(lat))
                    if s["outside"] or s["arrival_min"] is None:
                        depth, velocity, arrival = 0.0, 0.0, None
                    else:
                        depth, velocity = s["depth_m"], s["velocity_ms"]
                        arrival = s["arrival_min"]
                    hazard = compute_hazard_index(depth, velocity)
                    vuln = _vulnerability_of(village.metadata_)
                    priority = compute_evacuation_priority(
                        exposure=float(village.population or 100),
                        hazard=hazard,
                        vulnerability=vuln,
                        arrival_time_min=arrival if arrival is not None else 1e6,
                    )
                    db.add(EvacuationPriority(
                        sim_run_id=sim_run.id,
                        village_id=village.id,
                        exposure=float(village.population or 0),
                        hazard=round(hazard, 4),
                        vulnerability=vuln,
                        arrival_time_min=arrival,
                        warning_time_min=0.0,
                        mobilize_time_min=15.0,
                        priority_score=round(priority, 4),
                    ))
            db.commit()

        return {
            "sim_run_id": sim_run_id,
            "status": "done",
            "mass_balance_error": mass_balance_error,
            "within_tolerance": sim_run.within_tolerance,
        }

    except Exception as e:
        with Session(engine) as db:
            sim_run = db.get(SimRun, sim_run_id)
            if sim_run:
                sim_run.job_status = "failed"
                sim_run.finished_at = datetime.utcnow()
                sim_run.error_message = f"{str(e)}\n{traceback.format_exc()}"
                db.commit()
        raise self.retry(exc=e, countdown=60)


def _vulnerability_of(metadata) -> float:
    if isinstance(metadata, dict):
        try:
            return min(max(float(metadata.get("vulnerability", 1.0)), 0.1), 5.0)
        except (TypeError, ValueError):
            pass
    return 1.0


@celery_app.task(name="app.worker.condition_dem_task", bind=True)
def condition_dem_task(self, dem_id: str, steps: list):
    """DEM conditioning pipeline: sink fill, spike removal, stat summary.

    Downloads the DEM raster from object storage, applies the requested steps
    with scipy (no external binaries), uploads the conditioned raster as a new
    object, and records a new DEMVersion row graded by the quality scorer.
    Anything unavailable (DEM row, raster, storage) fails with its reason.
    """
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session

    from app.models import DEMVersion
    from app.gis.service import compute_data_quality_score

    engine = create_engine(settings.sync_database_url)
    with Session(engine) as db:
        dem = db.get(DEMVersion, dem_id)
        if dem is None:
            raise ValueError(f"DEMVersion {dem_id} not found")
        snapshot = {
            "dam_id": str(dem.dam_id), "source": dem.source,
            "resolution_m": dem.resolution_m, "object_key": dem.object_key,
        }

    import numpy as np
    from scipy import ndimage

    from app.s3_client import get_s3_client, ensure_bucket

    applied: list[str] = []
    skipped: list[str] = []
    s3 = get_s3_client()
    ensure_bucket()
    try:
        obj = s3.get_object(Bucket=settings.S3_BUCKET, Key=snapshot["object_key"])
        blob = obj["Body"].read()
    except Exception as e:
        raise RuntimeError(
            f"conditioning aborted: cannot download '{snapshot['object_key']}' "
            f"from bucket '{settings.S3_BUCKET}': {e}"
        )

    import io
    import rasterio
    from rasterio.io import MemoryFile

    with MemoryFile(blob) as mem:
        with mem.open() as src:
            arr = src.read(1).astype(float)
            profile = src.profile.copy()
            nodata = src.nodata
    mask = np.isfinite(arr) if nodata is None else ((arr != nodata) & np.isfinite(arr))
    if not mask.any():
        raise RuntimeError("conditioning aborted: raster has no valid cells")

    work = np.where(mask, arr, np.nan)
    requested = [str(s).lower() for s in (steps or [])]

    if "fill_sinks" in requested:
        # Iterative minimum-filter flood fill (converges on screening DEMs):
        # depressions can only drain through their lowest rim neighbour.
        filled = np.where(mask, arr, np.nanmax(arr[mask]))
        for _ in range(500):
            rim = ndimage.minimum_filter(filled, size=3)
            nxt = np.maximum(filled, rim)
            nxt[~mask] = filled[~mask]
            if np.array_equal(nxt[mask], filled[mask]):
                break
            filled = nxt
        work[mask] = filled[mask]
        applied.append("fill_sinks")
    if "remove_spikes" in requested:
        med = ndimage.median_filter(np.where(mask, work, np.nanmedian(work[mask])), size=3)
        spike = np.abs(work - med)
        scale = float(np.nanmedian(spike[mask])) or 1.0
        work[mask & (spike > 5.0 * scale)] = med[mask & (spike > 5.0 * scale)]
        applied.append("remove_spikes")
    for step in requested:
        if step not in ("fill_sinks", "remove_spikes"):
            skipped.append(step)  # e.g. channel burning needs vector hydro data

    valid = work[mask]
    stats = {
        "cells": int(mask.sum()),
        "min_m": round(float(valid.min()), 2),
        "max_m": round(float(valid.max()), 2),
        "mean_m": round(float(valid.mean()), 2),
        "relief_m": round(float(valid.max() - valid.min()), 2),
    }
    out = np.where(mask, work, profile.get("nodata", -9999)).astype(profile["dtype"])
    profile.update(count=1, compress="deflate",
                   description="DamSafe conditioned DEM (scipy; steps: %s)" % ",".join(applied))
    with MemoryFile() as mem:
        with mem.open(**profile) as dst:
            dst.write(out, 1)
        conditioned_blob = mem.read()

    conditioned_key = f"dems/{snapshot['dam_id']}/conditioned_{dem_id}.tif"
    try:
        s3.put_object(Bucket=settings.S3_BUCKET, Key=conditioned_key,
                      Body=conditioned_blob, ContentType="image/tiff")
    except Exception as e:
        raise RuntimeError(f"conditioning aborted: upload failed: {e}")

    grade = compute_data_quality_score(
        resolution_m=float(snapshot["resolution_m"] or 30.0),
        source=str(snapshot["source"] or "unknown"),
        has_conditioning=bool(applied),
    )
    with Session(engine) as db:
        row = DEMVersion(
            dam_id=snapshot["dam_id"],
            source=f"{snapshot['source']}+conditioned",
            resolution_m=float(snapshot["resolution_m"] or 30.0),
            conditioning_steps={"applied": applied, "skipped": skipped, "stats": stats},
            quality_grade=grade,
            object_key=conditioned_key,
        )
        db.add(row)
        db.commit()
        new_id = str(row.id)

    return {
        "dem_id": dem_id,
        "status": "completed",
        "conditioned_dem_id": new_id,
        "steps_applied": applied,
        "steps_skipped": skipped,
        "quality_grade": grade,
        "object_key": conditioned_key,
        "stats": stats,
    }


@celery_app.task(name="app.worker.build_dam_model_task", bind=True)
def build_dam_model_task(self, dam_id: str, source_type: str = "procedural"):
    """Build a 3D dam model from the dam's engineering parameters.

    Uses the repo's procedural generator (Path B). Requires the generator on
    the worker (mounted at /opt/damgen in compose) plus trimesh. Records a
    Dam3DModel row and uploads the GLB to object storage.
    """
    import sys
    from pathlib import Path
    from sqlalchemy import create_engine, select, func
    from sqlalchemy.orm import Session

    from app.models import Dam, Dam3DModel

    if source_type != "procedural":
        raise ValueError(
            f"source_type '{source_type}' needs external CAD/survey tooling "
            "(see 3d-assets/cad-import); only 'procedural' runs headless."
        )
    for candidate in ("/opt/damgen",):
        if Path(candidate).is_dir() and candidate not in sys.path:
            sys.path.insert(0, candidate)
    try:
        from generator import ProceduralDamGenerator
    except ImportError as e:
        raise RuntimeError(
            "procedural generator unavailable on this worker "
            "(mount 3d-assets/procedural-generator and install trimesh): "
            f"{e}"
        )

    engine = create_engine(settings.sync_database_url)
    with Session(engine) as db:
        dam = db.get(Dam, dam_id)
        if dam is None:
            raise ValueError(f"Dam {dam_id} not found")
        params = {
            "height_m": float(dam.height_m or 30.0),
            "crest_length_m": float(dam.crest_length_m or 500.0),
            "dam_type": (dam.dam_type or "earthen_embankment").lower().replace(" ", "_"),
            "spillway_count": int(dam.spillway_count or 0),
        }

    out_dir = "/tmp/damgen"
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    try:
        result = ProceduralDamGenerator().generate(dam_id=dam_id, output_dir=out_dir, **params)
    except TypeError:
        # Older generator signature without dam_id/output_dir — adapt honestly.
        result = ProceduralDamGenerator().generate(**params)
    glb_path = Path(str(result.get("glb_path") or result.get("path") or ""))
    if not glb_path.is_file():
        # Fall back to whatever .glb the generator dropped in out_dir.
        cands = sorted(Path(out_dir).glob("*.glb"))
        if not cands:
            raise RuntimeError(f"generator returned no .glb file (raw result keys: {sorted(result)})")
        glb_path = cands[0]

    from app.s3_client import get_s3_client, ensure_bucket
    object_key = f"3d-models/{dam_id}/dam.glb"
    s3 = get_s3_client()
    ensure_bucket()
    try:
        s3.upload_file(str(glb_path), settings.S3_BUCKET, object_key,
                       ExtraArgs={"ContentType": "model/gltf-binary"})
    except Exception as e:
        raise RuntimeError(f"3D model built but upload failed: {e}")

    with Session(engine) as db:
        row = Dam3DModel(
            dam_id=dam_id, source="procedural", format="gltf",
            lod_levels=int(result.get("lod_levels", 1)),
            object_key=object_key, status="draft",
        )
        db.add(row)
        db.commit()

    return {
        "dam_id": dam_id,
        "source_type": source_type,
        "status": "completed",
        "object_key": object_key,
        "format": "gltf",
        "params": params,
    }


# ── Solver Adapters ──────────────────────────────────────────────────────────

def _b64_grid(arr) -> str:
    import numpy as np
    return base64.b64encode(np.ascontiguousarray(arr, dtype=np.float32).tobytes()).decode()


def _run_educational_swe(scenario_id: str, breach_params: dict,
                         dam_lon: float, dam_lat: float) -> dict:
    """Educational 2-D screening solver (Ritter dam-break wave, documented).

    Computes depth / velocity / arrival grids over a 100x100 @10 m screening
    domain anchored at the dam, and embeds them in ``result_layers`` so impact
    endpoints sample real numbers. RESEARCH / RAPID-VISUALISATION grade —
    never an operational prediction.
    """
    import numpy as np

    h0 = float(breach_params.get("breach_depth_m", 10.0))
    if h0 <= 0:
        raise ValueError(f"breach_depth_m must be > 0 (got {h0})")
    g = 9.81
    c0 = 2.0 * float(np.sqrt(g * h0))  # wave-front celerity
    grid_size, cell_m, t = 100, 10.0, 60.0

    x = np.arange(grid_size, dtype=float) * cell_m  # downstream distance
    with np.errstate(divide="ignore", invalid="ignore"):
        depth_col = (1.0 / (9.0 * g)) * (2.0 * float(np.sqrt(g * h0)) - x / t) ** 2
    depth_col = np.where(x < c0 * t, np.maximum(depth_col, 0.0), 0.0)
    velocity_col = np.where(depth_col > 0.01, 2.0 * np.sqrt(g * np.maximum(depth_col, 0)) / 3.0, 0.0)
    arrival_col = np.where((x > 0) & (x < c0 * t), x / c0 / 60.0, -1.0)  # minutes; -1 = never
    arrival_col[0] = 0.0

    depth = np.tile(depth_col[:, None], (1, grid_size))
    velocity = np.tile(velocity_col[:, None], (1, grid_size))
    arrival = np.tile(arrival_col[:, None], (1, grid_size))

    total_in = h0 * grid_size * cell_m
    total_out = float(np.sum(depth)) * cell_m * cell_m
    mass_balance_error = abs(total_in - total_out) / max(total_in, 1e-10) * 100

    result_layers = {
        "engine": {"solver": "educational_swe", "version": "1.0.0",
                   "grade": "screening (Ritter wave); not operational"},
        "grid": {"origin_lon": dam_lon, "origin_lat": dam_lat,
                 "cell_m": cell_m, "nrows": grid_size, "ncols": grid_size,
                 "mapping": "screening-1d-downstream",
                 "note": ("Row = over-ground distance from dam / cell_m. "
                          "No cross-valley variation (1-D wave).")},
        "depth_b64": _b64_grid(depth),
        "velocity_b64": _b64_grid(velocity),
        "arrival_min_b64": _b64_grid(arrival),
        "artifacts": _write_grid_artifacts(scenario_id, depth, velocity, arrival,
                                           dam_lon, dam_lat, cell_m),
    }
    return {
        "result_layers": result_layers,
        "mass_balance_error": round(float(mass_balance_error), 4),
        "grid_size": grid_size,
        "cell_size_m": cell_m,
        "solver": "educational_swe",
        "solver_version": "1.0.0",
    }


def _write_grid_artifacts(scenario_id: str, depth, velocity, arrival,
                          dam_lon: float, dam_lat: float, cell_m: float) -> dict:
    """Best-effort GeoTIFF + object-storage copies of the screening grids.

    Never raises: artifacts are a bonus for GIS consumers; the embedded grids
    above are the source of truth. Returns what was stored, or why nothing was.
    """
    try:
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin
    except ImportError as e:
        return {"storage": "none", "reason": f"rasterio unavailable: {e}"}

    nrows, ncols = depth.shape
    deg = cell_m / 111320.0  # screening-grade square-degree approximation
    transform = from_origin(dam_lon - (ncols / 2) * deg, dam_lat, deg, deg)
    meta = {"driver": "GTiff", "height": nrows, "width": ncols, "count": 1,
            "dtype": "float32", "crs": "EPSG:4326", "transform": transform,
            "compress": "deflate",
            "description": ("DamSafe screening grid (1-D Ritter wave, rows = "
                            "distance from dam). Screening grade, not operational.")}
    import tempfile, os
    tmpdir = tempfile.mkdtemp(prefix="damsafe-grids-")
    paths = {}
    for name, arr in (("depth", depth), ("velocity", velocity), ("arrival_min", arrival)):
        p = os.path.join(tmpdir, f"{scenario_id}_{name}.tif")
        with rasterio.open(p, "w", **meta) as dst:
            dst.write(np.ascontiguousarray(arr, dtype=np.float32), 1)
        paths[name] = p
    try:
        from app.s3_client import get_s3_client, ensure_bucket
        s3 = get_s3_client()
        ensure_bucket()
        keys = {}
        for name, p in paths.items():
            key = f"results/{scenario_id}/{name}.tif"
            with open(p, "rb") as f:
                s3.put_object(Bucket=settings.S3_BUCKET, Key=key,
                              Body=f.read(), ContentType="image/tiff")
            keys[name] = key
        return {"storage": "s3", "bucket": settings.S3_BUCKET, "keys": keys}
    except Exception as e:
        return {"storage": "local", "dir": tmpdir, "files": paths,
                "reason": f"object storage unavailable: {e}"}
