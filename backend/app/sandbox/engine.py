"""
DamSafe Twin Sandbox — terrain-constrained flood propagation engine.

Model (documented simplification, NOT hydrodynamics):
  Diffusive downhill distribution on a regular grid with Manning-style
  friction. Per timestep, each wet cell pushes water to lower neighbours
  with a Manning-analogue velocity v = (1/n) * h^(2/3) * sqrt(S), where
  S is the water-surface slope. Outflow is clamped to stored volume
  (stability, no oscillations). Rainfall adds uniform depth with small
  seeded spatial jitter. Closed domain borders (water ponds, never leaks).

  Per cell tracked: elevation, water depth, wet/dry, first-wet timestamp,
  max depth. Velocity/flow is a per-face proxy (not a momentum solution).

  Deterministic given (scenario, grid, seed). Fully vectorized with numpy
  (rolls over 4 neighbours) — O(steps * N^2) array ops, no Python
  per-cell loops, no O(N^2) pairwise work.

Interface note: `run_scenario(...) -> SimResult` is the seam where a
rigorous 2D shallow-water solver can later be substituted.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.sandbox.schemas import ScenarioParams

WET_THRESHOLD_M = 0.02   # below this a cell counts as dry
FLOOD_THRESHOLD_M = 0.05  # below this a cell counts as not inundated
MAX_STEPS = 3000

SEVERITY_MULT = {"partial": 0.6, "major": 1.0, "full": 1.4}
# Depth thresholds (m) shared with backend hazard policy: green/yellow/orange/red
SEVERITY_DEPTHS = (0.3, 1.0, 2.5)


@dataclass
class SimResult:
    arrival_min: np.ndarray   # (N,N) float32, -1 = never wet
    maxdepth_m: np.ndarray    # (N,N) float32
    source_mask: np.ndarray   # (N,N) bool, True inside the breach source zone
    severity: np.ndarray      # (N,N) int8 0..4
    flooded_area_km2: float
    flooded_cells: int
    steps_used: int
    sim_minutes: float
    volume_in_m3: float
    volume_stored_m3: float
    frames: list = None  # type: ignore[assignment]  # checkpoint states (t, cells, area, depth, stored)
    conditioning: dict | None = None  # river-conditioning stats (None = raw DEM run)


def parse_breach_cell(location: str, n: int) -> tuple[int, int]:
    if location == "dam":
        return n // 2, n // 2
    try:
        r, c = location.split(",")
        return max(0, min(n - 1, int(r))), max(0, min(n - 1, int(c)))
    except Exception:
        return n // 2, n // 2


def severity_grid(maxdepth: np.ndarray) -> np.ndarray:
    sev = np.zeros_like(maxdepth, dtype=np.int8)
    sev[maxdepth >= SEVERITY_DEPTHS[0]] = 1
    sev[maxdepth >= SEVERITY_DEPTHS[1]] = 2
    sev[maxdepth >= SEVERITY_DEPTHS[2]] = 3
    # depth >= 2.5 already class 3 ("red"); reserve 4 for extreme >= 5 m
    sev[maxdepth >= 5.0] = 4
    sev[maxdepth < FLOOD_THRESHOLD_M] = 0
    return sev


# Soil abstraction (initial loss + infiltration): rain below this rate soaks
# in instead of ponding. Also keeps explicit-scheme sloshing (rain jitter
# driving ± redistribution, recorded by max-over-time) under the 0.05 m
# inundation cutoff at the default 1x design storm.
INFIL_M_S = 15.0 / 1000 / 3600


def _weir_inflow_volumes(p: ScenarioParams, steps: int, dt: float) -> np.ndarray:
    """Per-step release volumes from the parametric breach hydrograph
    (broad-crested weir growth + reservoir drawdown, volume-normalized to
    the scenario release). Early-peaked, like a real breach — the uniform
    legacy inflow is what starves downstream routing."""
    from app.sandbox import hydrograph as hydro
    formation = hydro.formation_time_min(p.breach_severity, p.breach_formation_min)
    hg = hydro.compute_hydrograph(p.breach_width_m, p.breach_depth_m,
                                  p.initial_release_m3, formation,
                                  steps * dt / 60.0, dt)
    q = np.array(hg["discharge_m3s"], dtype=np.float64)
    vols = (q[:-1] + q[1:]) * 0.5 * dt
    tot = vols.sum()
    if tot > 0:
        vols *= float(p.initial_release_m3) / tot
    return vols


def propagate(elev: np.ndarray, cell_m: float, p: ScenarioParams,
              n_field: np.ndarray | None = None,
              inflow_trail: list[tuple[int, int]] | None = None,
              weir_inflow: bool = False) -> SimResult:
    """Run the propagation. elev: (N,N) float64 meters, row0 = north.

    n_field: optional per-cell Manning-n multiplier field (1.0 = uniform).
    Values < 1 route faster (channel conveyance), > 1 slower (floodplain
    friction). None preserves the exact legacy uniform-n behaviour.
    inflow_trail: optional downstream cells sharing the release. The inflow
    enters as a moving wave front over breach zone + trail instead of a
    point tap (which stacks a non-physical tower). None = legacy 3-row
    breach zone only.
    weir_inflow: shape the release by the breach hydrograph (early peak)
    instead of a uniform trickle. False = exact legacy inflow."""
    n = elev.shape[0]
    dx = float(cell_m)
    dt = float(p.timestep_s)
    steps = min(int(p.duration_min * 60 / dt), MAX_STEPS)
    sim_minutes = steps * dt / 60.0
    area = dx * dx

    rng = np.random.default_rng(p.seed)
    rain_rate = (20.0 / 1000 / 3600) * p.rainfall_factor  # m/s design storm
    # Infiltration abstraction: light rain soaks in instead of ponding the
    # whole domain (which used to count as "flooded" via the depth cutoff).
    net_rain_rate = max(0.0, rain_rate - (INFIL_M_S if p.rainfall_factor > 0 else 0.0))
    rain_jitter = 1.0 + (rng.random((n, n)) - 0.5) * 0.10 if p.rainfall_factor > 0 else np.ones((n, n))
    rain_add = net_rain_rate * dt * rain_jitter

    h = np.zeros((n, n), dtype=np.float64)
    arrival = np.full((n, n), -1.0, dtype=np.float64)
    maxdepth = np.zeros((n, n), dtype=np.float64)

    # ── Breach inflow: initial ponding + 30-min release hydrograph ──
    # Dumping the whole volume at T+0 would stack kilometres of water on
    # one cell; instead the release flows in over the first 30 sim-minutes
    # (documented screening approximation of a breach hydrograph).
    br, bc = parse_breach_cell(p.breach_location, n)
    k = max(1, int(round(p.breach_width_m / dx)))
    c0, c1 = max(0, bc - k // 2), min(n, bc - k // 2 + k)
    r0, r1 = max(0, br - 1), min(n, br + 2)  # 3-row breach zone (source reads sanely)
    zone_cells = [(r, c) for r in range(r0, r1) for c in range(c0, c1)]
    if inflow_trail:
        seen_zone = set(zone_cells)
        extra = [(int(r), int(c)) for r, c in inflow_trail
                 if 0 <= r < n and 0 <= c < n and (int(r), int(c)) not in seen_zone]
        source_cells = zone_cells + extra
    else:
        source_cells = zone_cells
    n_src = max(1, len(source_cells))
    s_rows = np.array([r for r, _ in source_cells])
    s_cols = np.array([c for _, c in source_cells])
    depth0 = min(float(p.breach_depth_m), 200.0) * SEVERITY_MULT[p.breach_severity]
    # The seed volume is conserved exactly; spreading it over the trail
    # trades a point tower for a wave front of equal volume.
    seed_depth = depth0 * len(zone_cells) / n_src
    h[s_rows, s_cols] = seed_depth
    arrival[s_rows, s_cols] = 0.0
    maxdepth[s_rows, s_cols] = seed_depth
    volume_in = float(depth0 * len(zone_cells) * area)
    # Spread the release over the whole simulated duration (breach erosion
    # takes hours, not minutes). Short runs release proportionally less —
    # volume accounting stays exact via volume_in.
    inflow_total_s = max(float(steps * dt), 60.0)
    inflow_rate = float(p.initial_release_m3) / inflow_total_s  # m³/s
    inflow_depth_per_step = inflow_rate * dt / (n_src * area)
    weir_vols = _weir_inflow_volumes(p, steps, dt) if weir_inflow else None

    n_manning = float(p.roughness)
    if n_field is None:
        n_field = np.ones((n, n), dtype=np.float64)
    else:
        n_field = np.asarray(n_field, dtype=np.float64)

    # Time-dependent checkpoints: real computed states (area/depth/volume)
    # recorded through the run — honest frames, not interpolated decoration.
    frame_every_min = max(5.0, (steps * dt / 60.0) / 24.0)
    next_frame_at = frame_every_min
    frames: list[dict] = []

    def _record_frame(t_min: float):
        wet_now = (maxdepth >= FLOOD_THRESHOLD_M).sum()
        downstream_now = maxdepth[~src] if (~src).any() else maxdepth
        frames.append({
            "t_min": round(t_min, 1),
            "flooded_cells": int(wet_now),
            "flooded_area_km2": round(float(wet_now * area / 1e6), 3),
            "max_depth_m": round(float(downstream_now.max(initial=0.0)), 2),
            "volume_stored_m3": round(float(h.sum() * area), 1),
        })

    # Source-zone mask (5x5 around breach): depths here reflect the inflow
    # tap, not downstream flooding. Public "peak depth" excludes this zone.
    # (Built BEFORE the loop so _record_frame can use it.)
    src = np.zeros((n, n), dtype=bool)
    src[max(0, br - 2):min(n, br + 3), max(0, bc - 2):min(n, bc + 3)] = True

    for step in range(1, steps + 1):
        t_min = step * dt / 60.0
        if t_min * 60.0 <= inflow_total_s:
            if weir_vols is not None:
                step_vol = float(weir_vols[step - 1]) if step - 1 < len(weir_vols) else 0.0
                h[s_rows, s_cols] += step_vol / (n_src * area)
                volume_in += step_vol
            else:
                h[s_rows, s_cols] += inflow_depth_per_step
                volume_in += inflow_rate * dt
        w = elev + h
        # water-surface slope to each neighbour (positive = downhill)
        w_e = np.roll(w, -1, axis=1); w_w = np.roll(w, 1, axis=1)
        w_s = np.roll(w, -1, axis=0); w_n = np.roll(w, 1, axis=0)
        s_e = np.clip((w - w_e) / dx, 0, None)
        s_w = np.clip((w - w_w) / dx, 0, None)
        s_s = np.clip((w - w_s) / dx, 0, None)
        s_n = np.clip((w - w_n) / dx, 0, None)
        # Manning-analogue speed per face (donor-cell depth, per-cell n)
        h23 = np.power(np.maximum(h, 0.0), 2.0 / 3.0)
        coef = h23 / (n_manning * n_field) * dt * dx  # flux volume per unit slope^0.5
        f_e = coef * np.sqrt(s_e); f_w = coef * np.sqrt(s_w)
        f_s = coef * np.sqrt(s_s); f_n = coef * np.sqrt(s_n)
        # closed borders: kill wrap-around fluxes from the rolls
        f_e[:, -1] = 0.0; f_w[:, 0] = 0.0
        f_s[-1, :] = 0.0; f_n[0, :] = 0.0
        out = f_e + f_w + f_s + f_n
        stored = h * area
        # stability clamp: never export more than stored
        scale = np.ones_like(out)
        over = out > stored
        scale[over] = stored[over] / np.maximum(out[over], 1e-12)
        f_e *= scale; f_w *= scale; f_s *= scale; f_n *= scale
        # inflows = neighbours' outflows toward this cell
        inflow = (np.roll(f_w, -1, axis=1) + np.roll(f_e, 1, axis=1)
                  + np.roll(f_n, -1, axis=0) + np.roll(f_s, 1, axis=0))
        h = h + rain_add + (inflow - (f_e + f_w + f_s + f_n)) / area
        np.clip(h, 0.0, None, out=h)
        # Sub-grid pressure equilibration: relax depth toward the 3x3 local
        # mean (mass-conserving). Kills non-physical spikes in sumps while
        # preserving bulk downhill transport. Documented approximation.
        local_mean = (h + np.roll(h, 1, axis=0) + np.roll(h, -1, axis=0)
                      + np.roll(h, 1, axis=1) + np.roll(h, -1, axis=1)
                      + np.roll(np.roll(h, 1, axis=0), 1, axis=1)
                      + np.roll(np.roll(h, 1, axis=0), -1, axis=1)
                      + np.roll(np.roll(h, -1, axis=0), 1, axis=1)
                      + np.roll(np.roll(h, -1, axis=0), -1, axis=1)) / 9.0
        h += 0.05 * (local_mean - h)
        np.clip(h, 0.0, None, out=h)
        volume_in += float(rain_add.sum() * area)
        wet = h > WET_THRESHOLD_M
        newly = wet & (arrival < 0)
        arrival[newly] = t_min
        np.maximum(maxdepth, h, out=maxdepth)
        if t_min >= next_frame_at or step == steps:
            _record_frame(t_min)
            next_frame_at += frame_every_min

    flooded = maxdepth >= FLOOD_THRESHOLD_M
    return SimResult(
        arrival_min=arrival.astype(np.float32),
        maxdepth_m=maxdepth.astype(np.float32),
        source_mask=src,
        severity=severity_grid(maxdepth),
        flooded_area_km2=float(flooded.sum() * area / 1e6),
        flooded_cells=int(flooded.sum()),
        steps_used=steps,
        sim_minutes=sim_minutes,
        volume_in_m3=volume_in,
        volume_stored_m3=float((h).sum() * area),
        frames=frames,
    )


def run_scenario(elev: np.ndarray, cell_m: float, p: ScenarioParams,
                   *, condition_rivers: bool = True) -> SimResult:
    """Conditioned pipeline: D8 river-channel conditioning (burned channels,
    snapped breach, conveyance-split roughness) then propagation.

    condition_rivers=False reproduces the legacy raw-DEM run exactly.
    propagate() itself is untouched and keeps its own legacy behaviour."""
    cond_stats: dict | None = None
    n_field: np.ndarray | None = None
    trail: list[tuple[int, int]] | None = None
    if condition_rivers:
        from app.sandbox.rivers import condition_domain
        cond = condition_domain(elev)
        elev = cond["elev"]
        p = p.model_copy(update={
            "breach_location": f"{cond['breach'][0]},{cond['breach'][1]}"})
        n_field = np.where(cond["channel"],
                           cond["n_chan_mult"], cond["n_plain_mult"])
        trail = cond["trail"]
        cond_stats = cond["stats"]
    result = propagate(elev, cell_m, p, n_field=n_field, inflow_trail=trail,
                       weir_inflow=condition_rivers)
    result.conditioning = cond_stats
    return result
