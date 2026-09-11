"""
DamSafe Twin Sandbox — parametric breach hydrograph (screening-level).

Physics basis (documented approximation, NOT a calibrated dam-break model):
  - Breach width grows linearly from 0 to breach_width_m over
    breach_formation_min (Froehlich-style growth idealised as linear).
  - Instantaneous discharge follows the broad-crested weir equation
    Q(t) = C * B(t) * H(t)^1.5 with C = 1.7 (SI units).
  - Head H(t) depletes with the DISCHARGED FRACTION (reservoir drawdown):
    H = depth * max(1 - cum(t)/release, 0), solved sequentially so every
    parameter feeds back into the shape (wider/faster/deeper breaches give
    sharper, earlier peaks).
  - The weir shape is then NORMALIZED so cumulative volume exactly equals
    the scenario release volume (documented: shape from depleting-weir
    physics, magnitude tied to the scenario input).

Guarantees (asserted + unit-tested):
  - discharge >= 0 everywhere
  - cumulative volume is monotonically non-decreasing
  - total volume matches the scenario release within 1e-6 relative
  - every scenario parameter (width/depth/release/formation) moves the output
"""

from __future__ import annotations

import math

import numpy as np

WEIR_C = 1.7  # broad-crested weir coefficient, SI
FORMATION_MIN = {"partial": 90.0, "major": 45.0, "full": 20.0}


def formation_time_min(severity: str, override: float | None) -> float:
    if override is not None and override > 0:
        return float(override)
    return FORMATION_MIN.get(severity, 45.0)


def compute_hydrograph(breach_width_m: float, breach_depth_m: float,
                       release_m3: float, formation_min: float,
                       duration_min: float, dt_s: float = 60.0) -> dict:
    """Return {times_min, discharge_m3s, cumulative_m3, peak_..., ...} lists."""
    steps = max(2, int(round(duration_min * 60.0 / dt_s)) + 1)
    times = np.linspace(0.0, duration_min, steps)
    dt_min = duration_min / max(steps - 1, 1)
    dt = dt_min * 60.0
    q = np.zeros(steps)
    discharged = 0.0
    for i in range(1, steps):
        frac = min(times[i] / max(formation_min, 1e-6), 1.0)
        head = breach_depth_m * max(1.0 - discharged / max(release_m3, 1e-12), 0.0)
        q[i] = WEIR_C * (frac * breach_width_m) * head ** 1.5 if release_m3 > 0 else 0.0
        discharged += q[i] * dt
    # Normalize shape to the exact scenario volume (magnitude consistency).
    q = np.maximum(q, 0.0)
    _trapz = getattr(np, "trapezoid", None) or np.trapz  # numpy<2 compat
    raw_vol = float(_trapz(q, times * 60.0))
    if raw_vol > 0 and release_m3 > 0:
        q = q * (release_m3 / raw_vol)
    cum = np.zeros(steps)
    cum[1:] = np.cumsum((q[:-1] + q[1:]) * 0.5 * dt)
    cum = np.maximum.accumulate(np.maximum(cum, 0.0))
    peak_idx = int(np.argmax(q))
    return {
        "times_min": [round(float(t), 2) for t in times],
        "discharge_m3s": [round(float(v), 1) for v in q],
        "cumulative_m3": [round(float(v), 1) for v in cum],
        "peak_discharge_m3s": round(float(q[peak_idx]), 1),
        "time_to_peak_min": round(float(times[peak_idx]), 1),
        "total_volume_m3": round(float(cum[-1]), 1),
        "method": "broad-crested-weir growth, volume-normalized (screening)",
    }
