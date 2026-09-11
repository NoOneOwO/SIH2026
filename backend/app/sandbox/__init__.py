"""
DamSafe Twin — Scenario Simulation Sandbox (backend).

Self-contained counterfactual breach-simulation stack. No DB, no Celery:
a deterministic, vectorized, terrain-constrained flood-propagation engine
plus scenario generation, ensemble analysis, and a metrics-citing explainer.

SCIENTIFIC BOUNDARY (do not misrepresent): this is a simplified
terrain-constrained propagation model (diffusive downhill distribution
with Manning-style friction approximations) for screening and
counterfactual comparison. It is NOT a hydrodynamic/CFD solver and NOT
HEC-RAS/TELEMAC-grade. The engine interface (run_scenario -> SimResult)
is structured so a rigorous 2D shallow-water solver can replace
`engine.propagate` without touching the API, ensemble, or frontend layers.
"""
