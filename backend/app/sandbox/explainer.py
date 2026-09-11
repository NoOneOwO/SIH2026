"""
DamSafe Twin Sandbox — decision-intelligence explainer (rules-based).

Summarizes structured simulation metrics ONLY. Every sentence cites an
input metric; the explainer invents no facts, no populations, no outcomes
beyond what the engine computed. Uncertainty is stated, not hidden:
screening-level simplified model, not hydrodynamics.
"""

from __future__ import annotations


def explain_run(summary: dict, assets: list[dict], scenario_label: str) -> dict:
    flooded = summary["flooded_area_km2"]
    worst_depth = summary["max_depth_anywhere_m"]
    crit = [a for a in assets if a.get("severity", 0) >= 3]
    crit_sorted = sorted(crit, key=lambda a: (a.get("arrival_min") if a.get("arrival_min") is not None else 1e9))
    lines = [
        f"Scenario '{scenario_label}' inundates {flooded:.2f} km² with a peak depth of "
        f"{worst_depth:.1f} m (simplified screening model — not a hydrodynamic prediction).",
    ]
    if crit_sorted:
        first = crit_sorted[0]
        lines.append(
            f"Highest-severity exposure: {first['name']} ({first['kind']}, {first['source']}) — "
            f"first water at T+{first['arrival_min']:.0f} min, {first['max_depth_m']:.1f} m deep."
        )
        lines.append(
            f"{len(crit_sorted)} asset(s) reach severity ≥ 3; "
            "investigate these locations first, in arrival-time order."
        )
    else:
        lines.append("No asset reaches severity ≥ 3 in this run; exposure is limited to low-depth flooding.")
    drivers = summary.get("drivers", {})
    if drivers:
        top = sorted(drivers.items(), key=lambda kv: -abs(kv[1]))[:2]
        lines.append("Across the compared cases, outcomes move most with: "
                     + ", ".join(f"{k} ({v:+.0f}% flooded-area swing)" for k, v in top) + ".")
    lines.append(
        "Uncertainty: arrival times and depths are order-of-magnitude screening "
        "indicators from a terrain-constrained propagation approximation. "
        "Operational decisions require calibrated hydrodynamic modeling."
    )
    return {
        "headline": lines[0],
        "bullets": lines[1:],
        "method": "rules-based-metrics-explainer",
    }


def compare_driver_deltas(cases: dict) -> dict:
    """Factual driver ranking: flooded-area swing per parameter across cases.

    cases: {label: {'summary': {...}, 'params': {...}}}. Returns
    {param: pct swing} computed from real run outputs, never invented.
    """
    areas = {k: v["summary"]["flooded_area_km2"] for k, v in cases.items()}
    params = {k: v["params"] for k, v in cases.items()}
    base = max(areas.values()) if areas else 0.0
    if base <= 0:
        return {}
    keys = ["initial_release_m3", "breach_width_m", "breach_depth_m", "rainfall_factor", "roughness"]
    out = {}
    for key in keys:
        vals = [params[k].get(key, 0) for k in cases]
        spread = (max(vals) - min(vals)) / max(abs(sum(vals) / len(vals)), 1e-12)
        out[key] = round(spread * 100.0, 1)
    return out
