"""DamSafe Twin — LISFLOOD-FP job lifecycle.

Stages a metric domain from repo terrain, writes official-format LISFLOOD
inputs (.par/.asc/weir/gauges), executes the real engine (Docker container
or preinstalled binary via LISFLOOD_MODE), parses genuine outputs
(.wd slices, .max, .maxtm, .maxVx/.maxVy, .stage, .mass).

Failure policy: any engine/input failure -> status failed + actual reason.
NEVER synthesize flood data.
"""

from __future__ import annotations

import base64
import concurrent.futures
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import numpy as np
from rasterio.warp import transform as warp_transform

from app.sandbox import assets as assets_mod

from .schemas import LisfloodRunRequest
from .stage import (
    Domain,
    prepare_domain,
    read_asc,
    trace_flow_path,
    weir_axis_for,
    write_asc,
)

SIMS_ROOT = Path(__file__).resolve().parent.parent.parent / "sims"
IMAGE = "damsafe-lisflood:cpu"
# Engine execution mode:
#   "docker" — `docker run` the engine image (local dev, VPS with Docker).
#   "direct" — execute a preinstalled lisflood binary in-process (hosts
#              without a Docker daemon, e.g. Render). The binary is baked
#              into backend/Dockerfile from the same pinned source.
ENGINE_MODE = os.environ.get("LISFLOOD_MODE", "docker").strip().lower()
DIRECT_BIN = os.environ.get("LISFLOOD_BIN", "/usr/local/bin/lisflood")
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="lisflood")

DEPTH_WET_M = 0.05   # inundated-cell threshold
ARRIVAL_WET_M = 0.10  # first-wetting threshold for arrival
GRID_CAP = 96        # max dimension of grids shipped to the frontend


# ------------------------------------------------------------------ helpers

def _job_dir(job_id: str) -> Path:
    return SIMS_ROOT / job_id


def _write_status(job_id: str, **fields) -> dict:
    path = _job_dir(job_id) / "status.json"
    try:
        current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        current = {"job_id": job_id}
    current.update(fields)
    current["updated_at"] = time.time()
    path.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


def read_status(job_id: str) -> dict | None:
    path = _job_dir(job_id) / "status.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=np.float32).tobytes()).decode()


def _downsample(arr: np.ndarray, cap: int = GRID_CAP) -> np.ndarray:
    rows, cols = arr.shape
    k = max(1, -(-max(rows, cols) // cap))  # ceil div
    return np.ascontiguousarray(arr[::k, ::k])


def _parse_mass(mass_path: Path) -> dict:
    """Parse LISFLOOD .mass rows -> progress + mass-balance diagnostics."""
    try:
        lines = mass_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return {}
    rows = []
    for ln in lines:
        parts = ln.split()
        if len(parts) < 12:
            continue
        try:
            rows.append([float(x) for x in parts[:12]])
        except ValueError:
            continue  # header line ("Time ...") or truncated final row
    if not rows:
        return {}
    a = np.array(rows)
    return {
        "sim_time_reached_s": float(a[-1, 0]),
        "timestep_s": float(a[-1, 1]),
        "iterations": int(a[-1, 3]),
        "flood_area_m2": float(a[-1, 4]),
        "volume_m3": float(a[-1, 5]),
        "qin_m3s": float(a[-1, 6]),
        "qout_m3s": float(a[-1, 8]),
        "q_error": float(a[-1, 9]),
        "v_error": float(a[-1, 10]),
        "mass_rows": len(rows),
    }


def _live_progress(jobdir: Path, sim_time_s: float) -> float | None:
    mass = _job_dir(jobdir.name) / "outputs" / "res.mass"
    info = _parse_mass(mass)
    t = info.get("sim_time_reached_s")
    if t is None or sim_time_s <= 0:
        return None
    return max(0.0, min(1.0, t / sim_time_s))


# ------------------------------------------------------------------ staging

def _exposure_points(dam_lat: float, dam_lon: float, dam_id: str) -> tuple[list[dict], str]:
    """Real OSM assets preferred; documented modeled ring points otherwise."""
    try:
        assets, provenance = assets_mod.load_assets(dam_id, dam_lat, dam_lon)
    except Exception:
        assets, provenance = assets_mod.modeled_points(dam_lat, dam_lon), "modeled"
    pts = [a for a in assets if a.get("lat") is not None and a.get("lon") is not None][:24]
    return pts, provenance


def stage_inputs(jobdir: Path, req: LisfloodRunRequest) -> dict:
    """Build domain + official LISFLOOD inputs. Returns staging manifest."""
    dom: Domain = prepare_domain(req.dam_id, req.domain_radius_km, req.cell_size_m)
    inputs = jobdir / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)

    dam_elev = float(dom.elev[dom.dam_row, dom.dam_col])
    level = req.reservoir_level_m
    if level is None:
        level = dam_elev + 12.0  # illustrative default; documented, user-overridable
    level = float(level)

    # Reservoir: UPSTREAM sector only (60° cone around -downstream), so water
    # starts behind the dam and must route through the valley — never a ring
    # that drains backwards over the upstream hillsides.
    ux, uy = float(dom.downstream_east), float(dom.downstream_north)
    res_radius_m = min(800.0, (min(dom.nrows, dom.ncols) * dom.cell_m) * 0.25)
    rr, cc = np.mgrid[0:dom.nrows, 0:dom.ncols]
    ex = (cc - dom.dam_col) * dom.cell_m   # east offset from dam
    ny = (dom.dam_row - rr) * dom.cell_m   # north offset from dam
    dist_m = np.hypot(ex, ny)
    with np.errstate(invalid="ignore", divide="ignore"):
        cosang = np.where(dist_m > 0, -(ex * ux + ny * uy) / np.maximum(dist_m, 1e-9), 1.0)
    upstream = (dist_m <= 1e-9) | (cosang > 0.5)
    wet = (dist_m <= res_radius_m) & upstream & (dom.elev < level)
    if not bool(wet.any()):
        raise ValueError(
            f"reservoir_level_m={level:.2f} is below all terrain within "
            f"{res_radius_m:.0f} m of the dam (min {float(dom.elev[dist_m <= res_radius_m].min()):.2f} m). "
            "Raise the reservoir level."
        )
    start = np.zeros_like(dom.elev)
    start[wet] = level - dom.elev[wet]

    # Breach weir at the dam cell, link axis along the valley direction.
    tag = weir_axis_for(ux, uy)
    crest = dam_elev - float(req.breach_depth_m)
    weir_line = (
        f"1\n{dom.dam_easting:.2f} {dom.dam_northing:.2f} {tag} 0.6 {crest:.2f} 0.7 "
        f"{float(req.breach_width_m):.2f}\n"
    )

    # Gauges at exposure points inside the domain (map coords = UTM metres).
    pts, provenance = _exposure_points(dom.dam_lat, dom.dam_lon, dom.dam_id)
    (es, ns) = warp_transform(
        "EPSG:4326", dom.dst_crs,
        [p["lon"] for p in pts], [p["lat"] for p in pts],
    ) if pts else ([], [])
    gauges: list[dict] = []
    for p, e, n in zip(pts, es, ns):
        col = int((e - dom.west) / dom.cell_m)
        row = int((dom.north - n) / dom.cell_m)
        inside = 0 <= col < dom.ncols and 0 <= row < dom.nrows
        gauges.append({**p, "easting": e, "northing": n, "row": row, "col": col,
                       "inside_domain": inside})

    write_asc(inputs / "dem.asc", dom.elev, dom.west, dom.north, dom.cell_m)
    write_asc(inputs / "reservoir.asc", start, dom.west, dom.north, dom.cell_m)
    (inputs / "breach.txt").write_text(weir_line, encoding="utf-8")
    inside_gauges = [g for g in gauges if g["inside_domain"]]
    with open(inputs / "gauges.stage", "w", encoding="utf-8") as f:
        f.write(f"{len(inside_gauges)}\n")
        for g in inside_gauges:
            f.write(f"{g['easting']:.2f} {g['northing']:.2f}\n")

    sim_s = float(req.duration_min) * 60.0
    save_s = float(min(1800.0, max(60.0, sim_s / 12.0)))
    # Docker mode mounts the job dir at /work; direct mode uses real paths.
    prefix = "/work" if ENGINE_MODE == "docker" else jobdir.as_posix()
    par = (
        "# DamSafe Twin LISFLOOD-FP dam-break (decision-support prototype)\n"
        f"# dam={dom.dam_id} mode={req.failure_mode} "
        "breach modelled as a static weir (instantaneous in v1)\n"
        f"DEMfile {prefix}/inputs/dem.asc\n"
        f"startfile {prefix}/inputs/reservoir.asc\n"
        f"weirfile {prefix}/inputs/breach.txt\n"
        f"stagefile {prefix}/inputs/gauges.stage\n"
        f"resroot {prefix}/outputs/res\n"
        f"sim_time {sim_s:.1f}\n"
        f"saveint {save_s:.1f}\n"
        f"massint {save_s:.1f}\n"
        f"fpfric {float(req.mannings_n):.4f}\n"
        "initial_tstep 1.0\n"
        "acceleration\n"
        "voutput\n"
    )
    (inputs / "sim.par").write_text(par, encoding="utf-8")

    # Valley flow path from the dam (steepest descent on the sim grid),
    # exported as lon/lat for the UI valley overlay.
    flow_cells = trace_flow_path(dom.elev, dom.dam_row, dom.dam_col)
    fe = [dom.west + (c + 0.5) * dom.cell_m for _, c in flow_cells[::2]]
    fn = [dom.north - (r + 0.5) * dom.cell_m for r, _ in flow_cells[::2]]
    flow_path: list[list[float]] = []
    if fe:
        flons, flats = warp_transform(dom.dst_crs, "EPSG:4326", fe, fn)
        flow_path = [[round(lo, 6), round(la, 6)] for lo, la in zip(flons, flats)][:200]

    return {
        "dam": {"id": dom.dam_id, "name": dom.dam_name, "lon": dom.dam_lon,
                "lat": dom.dam_lat, "height_m": dom.dam_height_m,
                "cell_elev_m": round(dam_elev, 2)},
        "dem": {"path": dom.dem_path, "src_crs": dom.src_crs, "dst_crs": dom.dst_crs,
                "utm_zone": dom.utm_zone, "nrows": dom.nrows, "ncols": dom.ncols,
                "cell_m": dom.cell_m, "west": dom.west, "north": dom.north},
        "downstream": {"east": round(ux, 4), "north": round(uy, 4)},
        "flow_path": flow_path,
        "reservoir": {"level_m": round(level, 2), "radius_m": round(res_radius_m, 1),
                      "wet_cells": int(wet.sum()),
                      "upstream_sector_only": True,
                      "volume_m3": round(float((start * dom.cell_m**2).sum()), 1)},
        "breach": {"easting": round(dom.dam_easting, 2), "northing": round(dom.dam_northing, 2),
                   "row": dom.dam_row, "col": dom.dam_col, "axis": tag,
                   "width_m": float(req.breach_width_m), "depth_m": float(req.breach_depth_m),
                   "crest_m": round(crest, 2),
                   "formation_time_min": float(req.breach_formation_time_min),
                   "formation_note": "v1 weir is static (instantaneous breach); "
                                     "formation time stored for future time-varying support"},
        "gauges": gauges,
        "exposure_provenance": provenance,
        "sim": {"duration_s": sim_s, "save_s": save_s, "mannings_n": float(req.mannings_n),
                "failure_mode": req.failure_mode},
    }


# ------------------------------------------------------------------ execution

def _engine_available() -> tuple[bool, str]:
    """Check the configured engine backend (docker image or direct binary)."""
    if ENGINE_MODE == "direct":
        if not Path(DIRECT_BIN).is_file():
            return False, (
                f"direct engine binary not found at LISFLOOD_BIN={DIRECT_BIN} "
                "(bake it in via backend/Dockerfile)"
            )
        return True, f"ok (direct: {DIRECT_BIN})"
    if shutil.which("docker") is None:
        return False, "docker executable not found on PATH"
    try:
        r = subprocess.run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
                           capture_output=True, text=True, timeout=30)
    except Exception as e:
        return False, f"docker daemon unreachable: {e}"
    if IMAGE not in (r.stdout or ""):
        return False, f"image '{IMAGE}' not present — build solver-workers/lisflood-adapter"
    return True, "ok"


# Backwards-compatible alias (older logs/docs reference the docker check).
_docker_available = _engine_available


def _run_engine(job_id: str, timeout_s: float) -> dict:
    """Execute the real engine (docker container or direct binary).

    Returns {returncode, elapsed_s}. stdout/stderr always land in the job dir.
    """
    jobdir = _job_dir(job_id)
    stdout_path = jobdir / "stdout.log"
    stderr_path = jobdir / "stderr.log"
    t0 = time.time()
    if ENGINE_MODE == "direct":
        cmd = [DIRECT_BIN, "-v", str(jobdir / "inputs" / "sim.par")]
        try:
            with open(stdout_path, "w", encoding="utf-8") as out, open(stderr_path, "w", encoding="utf-8") as err:
                try:
                    proc = subprocess.Popen(cmd, stdout=out, stderr=err, cwd=str(jobdir))
                    rc = proc.wait(timeout=timeout_s)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    raise TimeoutError(f"engine exceeded timeout_s={timeout_s}")
        except FileNotFoundError:
            raise RuntimeError(f"direct engine binary not found: {DIRECT_BIN}")
        return {"returncode": rc, "elapsed_s": round(time.time() - t0, 1)}
    cname = f"damsafe-lf-{job_id}"
    cmd = ["docker", "run", "--rm", "--name", cname,
           "-v", f"{jobdir}:/work", IMAGE, "-v", "/work/inputs/sim.par"]
    try:
        with open(stdout_path, "w", encoding="utf-8") as out, open(stderr_path, "w", encoding="utf-8") as err:
            proc = subprocess.Popen(cmd, stdout=out, stderr=err)
            try:
                rc = proc.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                proc.kill()
                subprocess.run(["docker", "kill", cname], capture_output=True, timeout=30)
                raise TimeoutError(f"engine exceeded timeout_s={timeout_s}")
    except FileNotFoundError:
        raise RuntimeError("docker executable not found on PATH")
    return {"returncode": rc, "elapsed_s": round(time.time() - t0, 1)}


def _output_files(jobdir: Path) -> list[str]:
    out = jobdir / "outputs"
    if not out.exists():
        return []
    return sorted(p.name for p in out.iterdir() if p.is_file())


def _severity(max_depth: float) -> tuple[str, str]:
    if max_depth < DEPTH_WET_M:
        return "SAFE", "dry"
    if max_depth < 0.3:
        return "AT RISK", "low"
    if max_depth < 1.0:
        return "AT RISK", "moderate"
    if max_depth < 2.5:
        return "CRITICAL", "high"
    return "CRITICAL", "extreme"


def parse_results(job_id: str, manifest: dict) -> dict:
    """Parse genuine LISFLOOD outputs into stats, impacts and viz grids."""
    jobdir = _job_dir(job_id)
    out = jobdir / "outputs"
    files = _output_files(jobdir)
    if "res.max" not in files:
        raise RuntimeError(f"engine produced no res.max; files: {files}")

    maxd, _ = read_asc(out / "res.max")
    maxtm, _ = read_asc(out / "res.maxtm")
    dem = manifest["dem"]
    cell_m = float(dem["cell_m"])

    wet = maxd > DEPTH_WET_M
    wet_cells = int(wet.sum())
    max_depth = float(maxd[wet].max()) if wet_cells else 0.0
    area_km2 = wet_cells * cell_m**2 / 1e6

    vx = vy = None
    if "res.maxVx" in files and "res.maxVy" in files:
        vx_raw, _ = read_asc(out / "res.maxVx")  # (rows, cols+1): x-face fluxes
        vy_raw, _ = read_asc(out / "res.maxVy")  # (rows+1, cols): y-face fluxes
        # Cell-centred speed from face velocities (matches engine vel output).
        vx = 0.5 * (vx_raw[:, :-1] + vx_raw[:, 1:])
        vy = 0.5 * (vy_raw[:-1, :] + vy_raw[1:, :])
        if vx.shape != maxd.shape or vy.shape != maxd.shape:
            raise RuntimeError(f"velocity grids {vx.shape}/{vy.shape} vs depth {maxd.shape}")
    speed = np.hypot(vx, vy) if vx is not None else None
    max_speed = float(speed[wet].max()) if speed is not None and wet_cells else 0.0

    # Depth time slices -> animation frames (downsampled).
    frames: list[dict] = []
    i = 0
    frame_grids = []
    save_s = float(manifest["sim"]["save_s"])
    while True:
        name = f"res-{i:04d}.wd"
        if name not in files:
            break
        arr, _ = read_asc(out / name)
        small = _downsample(np.clip(arr, 0, None))
        frame_grids.append(small)
        frames.append({"index": i, "time_s": round(i * save_s, 1),
                       "max_depth_m": round(float(arr.max()), 3),
                       "wet_cells": int((arr > DEPTH_WET_M).sum())})
        i += 1

    # Gauge series -> per-point arrival (first wetting), max depth.
    # NOTE: the .stage file starts with human-readable header lines whose
    # numeric echo ("1 <x> <y> <elev>") must NOT be parsed as data — only
    # rows after the "Time; stages ..." marker are samples.
    arrivals: dict[int, float] = {}
    gauge_max: dict[int, float] = {}
    stage_path = out / "res.stage"
    inside = [g for g in manifest["gauges"] if g["inside_domain"]]
    if stage_path.exists() and inside:
        cols: list[list[float]] = [[] for _ in inside]
        times: list[float] = []
        in_data = False
        for ln in stage_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not in_data:
                if ln.strip().lower().startswith("time"):
                    in_data = True
                continue
            parts = ln.split()
            if len(parts) < 1 + len(inside):
                continue
            try:
                row = [float(x) if x != "-" else 0.0 for x in parts[: 1 + len(inside)]]
            except ValueError:
                continue
            if row[0] < 0 or any(d < 0 or d > 10000 for d in row[1:]):
                continue
            times.append(row[0])
            for k in range(len(inside)):
                cols[k].append(row[1 + k])
        for k, series in enumerate(cols):
            s = np.array(series)
            gauge_max[k] = float(s.max()) if len(s) else 0.0
            wet_idx = np.nonzero(s > ARRIVAL_WET_M)[0]
            arrivals[k] = float(times[int(wet_idx[0])]) if len(wet_idx) else -1.0

    impacts = []
    for k, g in enumerate(inside):
        r, c = g["row"], g["col"]
        grid_md = float(maxd[r, c]) if maxd[r, c] > 0 else 0.0
        # Prefer the gauge's own depth history (save-resolution truth at the
        # point) over the all-time grid max (which can hold a sub-save-step
        # transient at weir faces). Fall back to the grid sample.
        series_md = gauge_max.get(k, 0.0)
        md = series_md if series_md > 0 else grid_md
        at_grid = float(maxtm[r, c]) if md > DEPTH_WET_M else -1.0
        at = arrivals.get(k, at_grid)
        if at is not None and at >= 0 and (gauge_max.get(k, 0.0) <= DEPTH_WET_M):
            at = -1.0  # gauge never wet -> arrival unknown, don't borrow grid value
        sp = float(speed[r, c]) if speed is not None else 0.0
        status, band = _severity(md)
        impacts.append({
            "name": g.get("name", f"point-{k}"),
            "kind": g.get("kind", "exposure_point"),
            "source": g.get("source", manifest.get("exposure_provenance", "modeled")),
            "lon": g["lon"], "lat": g["lat"],
            "max_depth_m": round(md, 3),
            "arrival_min": round(at / 60.0, 1) if at is not None and at >= 0 else None,
            "max_speed_ms": round(sp, 3),
            "status": status, "severity": band,
            "inundated": bool(md > DEPTH_WET_M),
        })
    outside = [
        {"name": g.get("name", "point"), "kind": g.get("kind", "exposure_point"),
         "lon": g["lon"], "lat": g["lat"], "status": "OUTSIDE DOMAIN",
         "inundated": False, "max_depth_m": 0.0, "arrival_min": None,
         "max_speed_ms": 0.0, "severity": "unknown",
         "source": g.get("source", manifest.get("exposure_provenance", "modeled"))}
        for g in manifest["gauges"] if not g["inside_domain"]
    ]

    mass = _parse_mass(out / "res.mass")

    result = {
        "job_id": job_id,
        "engine": {"image": IMAGE, "version": "LISFLOOD-FP 5.9 (Bristol lineage, CPU)",
                   "solver": "local-inertia (acceleration)",
                   "outputs": files},
        "stats": {
            "max_depth_m": round(max_depth, 3),
            "inundated_cells": wet_cells,
            "inundated_area_km2": round(area_km2, 4),
            "max_speed_ms": round(max_speed, 3),
            "mass_q_error": mass.get("q_error"),
            "mass_v_error": mass.get("v_error"),
            "frames": len(frames),
        },
        "grid": {"nrows": int(maxd.shape[0]), "ncols": int(maxd.shape[1]),
                 "crs": dem["dst_crs"], "west": dem["west"], "north": dem["north"],
                 "cell_m": cell_m,
                 "max_depth_b64": _b64(_downsample(np.clip(maxd, 0, None))),
                 "arrival_min_b64": _b64(_downsample(np.where(wet, maxtm / 60.0, -1.0))),
                 "max_depth_shape": list(_downsample(maxd).shape)},
        "frames_meta": frames,
        "frames_b64": _b64(np.stack(frame_grids)) if frame_grids else "",
        "frames_shape": list(np.stack(frame_grids).shape) if frame_grids else [],
        "flow_path": manifest.get("flow_path", []),
        "downstream": manifest.get("downstream", {}),
        "impacts": impacts + outside,
        "mass": mass,
    }
    (jobdir / "result.json").write_text(json.dumps(result), encoding="utf-8")
    return result


# ------------------------------------------------------------------ driver

def execute(job_id: str, req: LisfloodRunRequest) -> None:
    """Worker entry: stage -> run engine -> parse. All failures recorded."""
    jobdir = _job_dir(job_id)
    t_start = time.time()
    try:
        ok, msg = _engine_available()
        if not ok:
            raise RuntimeError(f"LISFLOOD engine unavailable: {msg}")

        _write_status(job_id, status="running", stage="preparing_terrain", progress=2.0)
        manifest = stage_inputs(jobdir, req)
        (jobdir / "metadata.json").write_text(
            json.dumps({"job_id": job_id, "request": req.model_dump(), **manifest}, indent=2),
            encoding="utf-8",
        )
        _write_status(job_id, stage="routing_flood_wave", progress=5.0,
                      sim_time_s=manifest["sim"]["duration_s"])

        eng = _run_engine(job_id, float(req.timeout_s))
        if eng["returncode"] != 0:
            tail = ""
            for log in ("stdout.log", "stderr.log"):
                p = jobdir / log
                if p.exists():
                    tail += f"\n--- {log} (tail) ---\n" + "\n".join(
                        p.read_text(encoding="utf-8", errors="replace").splitlines()[-25:])
            raise RuntimeError(f"engine exited rc={eng['returncode']}.{tail}")

        _write_status(job_id, stage="calculating_inundation", progress=92.0)
        result = parse_results(job_id, manifest)
        _write_status(
            job_id, status="done", stage="complete", progress=100.0,
            elapsed_s=round(time.time() - t_start, 1),
            engine_s=eng["elapsed_s"],
            stats=result["stats"],
            output_files=result["engine"]["outputs"],
        )
    except Exception as e:  # noqa: BLE001 — surfaced verbatim, never masked
        _write_status(job_id, status="failed", stage="failed", progress=0.0,
                      error=f"{type(e).__name__}: {e}",
                      elapsed_s=round(time.time() - t_start, 1))


def submit(req: LisfloodRunRequest) -> str:
    job_id = uuid.uuid4().hex[:12]
    jobdir = _job_dir(job_id)
    (jobdir / "inputs").mkdir(parents=True, exist_ok=True)
    (jobdir / "outputs").mkdir(parents=True, exist_ok=True)
    _write_status(job_id, status="queued", stage="queued", progress=0.0,
                  dam_id=req.dam_id)
    POOL.submit(execute, job_id, req)
    return job_id


def status_with_progress(job_id: str) -> dict | None:
    st = read_status(job_id)
    if st is None:
        return None
    if st.get("status") == "running" and st.get("stage") == "routing_flood_wave":
        pct = _live_progress(_job_dir(job_id), float(st.get("sim_time_s") or 0))
        if pct is not None:
            st = {**st, "progress": round(5.0 + 87.0 * pct, 1),
                  "sim_time_reached_s": _parse_mass(
                      _job_dir(job_id) / "outputs" / "res.mass").get("sim_time_reached_s")}
    return st
