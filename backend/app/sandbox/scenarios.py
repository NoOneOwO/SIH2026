"""
DamSafe Twin Sandbox — AI scenario agent (parameter generator).

Generates PLAUSIBLE PARAMETER SETS ONLY (best / likely / worst triplets
plus seeded ensembles). It NEVER computes or fabricates simulation
outcomes — every number below is an input for the numerical engine.

Heuristic basis (documented, screening-level): breach width scales with
dam height class; release volumes scale with severity presets; rainfall
and roughness span literature-typical ranges. Ranges are intentionally
wide because this is counterfactual exploration, not prediction.
"""

from __future__ import annotations

import numpy as np

from app.sandbox.schemas import ScenarioParams

# Severity presets: fraction-of-impoundment release volumes (m³) used as
# screening inputs. NOT calibrated to any specific dam.
SEVERITY_RELEASE_M3 = {"best": 5e6, "likely": 25e6, "worst": 120e6}
SEVERITY_MAP = {"best": "partial", "likely": "major", "worst": "full"}


def _preset(dam_id: str, label: str, seed: int) -> ScenarioParams:
    return ScenarioParams(
        dam_id=dam_id,
        label=label,
        reservoir_level_m=0.0,  # resolved against terrain mean at run time
        breach_location="dam",
        breach_width_m={"best": 30.0, "likely": 80.0, "worst": 200.0}[label],
        breach_depth_m={"best": 8.0, "likely": 20.0, "worst": 45.0}[label],
        breach_severity=SEVERITY_MAP[label],  # type: ignore[arg-type]
        initial_release_m3=SEVERITY_RELEASE_M3[label],
        roughness={"best": 0.08, "likely": 0.05, "worst": 0.03}[label],
        rainfall_factor={"best": 0.5, "likely": 1.0, "worst": 2.5}[label],
        duration_min=180.0,
        timestep_s=60.0,
        seed=seed,
    )


def generate_triplet(dam_id: str, seed: int = 7) -> dict:
    """Best / likely / worst parameter sets. No outcomes attached."""
    return {
        "best": _preset(dam_id, "best", seed),
        "likely": _preset(dam_id, "likely", seed + 1),
        "worst": _preset(dam_id, "worst", seed + 2),
        "method": "heuristic-severity-presets",
        "note": ("Parameter inputs only — flood outcomes come from the "
                 "numerical engine, never from this generator."),
    }


def generate_ensemble(dam_id: str, count: int = 10, seed: int = 7) -> list[ScenarioParams]:
    """Seeded ensemble spanning width/depth/release/rainfall/roughness."""
    rng = np.random.default_rng(seed)
    out = []
    for i in range(count):
        corner = rng.random()
        if corner < 0.25:
            base = _preset(dam_id, "best", seed + 100 + i)
        elif corner < 0.65:
            base = _preset(dam_id, "likely", seed + 100 + i)
        else:
            base = _preset(dam_id, "worst", seed + 100 + i)
        d = base.model_dump()
        d["label"] = f"ensemble-{i + 1}"
        d["breach_width_m"] = float(np.clip(d["breach_width_m"] * rng.uniform(0.7, 1.4), 10, 2000))
        d["breach_depth_m"] = float(np.clip(d["breach_depth_m"] * rng.uniform(0.7, 1.4), 2, 500))
        d["initial_release_m3"] = float(np.clip(d["initial_release_m3"] * rng.uniform(0.6, 1.6), 1e5, 5e9))
        d["rainfall_factor"] = float(np.clip(d["rainfall_factor"] * rng.uniform(0.7, 1.4), 0, 5))
        d["roughness"] = float(np.clip(d["roughness"] * rng.uniform(0.8, 1.25), 0.005, 0.5))
        base_formation = {"partial": 90.0, "major": 45.0, "full": 20.0}[d["breach_severity"]]
        d["breach_formation_min"] = float(np.clip(base_formation * rng.uniform(0.6, 1.6), 5, 240))
        d["seed"] = seed + 100 + i
        out.append(ScenarioParams(**d))
    return out
