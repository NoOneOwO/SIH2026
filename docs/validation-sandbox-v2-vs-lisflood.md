# DamSafe Twin — Sandbox v2 vs LISFLOOD-FP Cross-Model Validation (Tehri d4)

## 1. Validation Overview

| Field | Value |
|-------|-------|
| Report Date | 2026-09-21 |
| Dam | Tehri Dam (d4), Bhagirathi valley, Uttarakhand |
| Scenario | overtopping / likely, 80 m × 20 m breach, 180 min |
| Screening solver | sandbox-diffusive-screening-v2 (D8 channel-conditioned) |
| Reference solver | LISFLOOD-FP 5.9, local-inertia, 30 m UTM domain, job e03bc4c24a4d |
| Matched conditions | release 7.1 M m³ (= LISFLOOD stored volume), Manning 0.05, 180 min |

## 2. What Changed in v2 (and why)

| Defect in v1 (measured) | Fix |
|-------------------------|-----|
| Breach seeded at blind grid-center — off-river for Tehri/Idukki (channel accumulation 2–3 vs ~1000+) | D8 accumulation + snap release to the river at the dam |
| Uniform 3 h trickle + point tap → 93 m non-physical tower at the tap | Release shaped by the broad-crested-weir breach hydrograph, distributed over a 20-cell downstream wave trail (pile now ~15–20 m) |
| Resampling smears the gorge away; single-cell trench stalls the wave | Burned valley cross-section (channel + 1-cell ring), sill carving (max 2.9 m at Tehri), split channel/floodplain conveyance (0.40x / 1.30x n) |
| 20 mm/h design storm ponded the whole domain (flooded-area metric contaminated) | 15 mm/h soil abstraction; rain alone can no longer trip the 0.05 m cutoff |
| Sink fill never converged (6.2% pits left); D8 walks died after 2 cells | Barnes priority-flood (exact) + accumulation-ridge trail walking (22-cell trails) |

## 3. Cross-Model Comparison (inside the LISFLOOD 6×6 km domain)

| Metric | LISFLOOD-FP (reference) | Sandbox v2 | Sandbox v1 |
|--------|------------------------|------------|------------|
| Inundated area in domain | 5.79 km² | 1.9–2.5 km² | 1.2–1.9 km² |
| Mean depth 0–1 km | 22.7 m | 23.0 m | — |
| Mean depth 1–2 km | 13.0 m | 8.4 m | — |
| Mean depth 2–3 km | 4.3 m | 1.5 m | — |
| Reach 3–5 km | 152 cells @ 2.1 m | ~0 | ~0 |
| Footprint IoU | — | ~0.08–0.11 | ~0.09–0.10 |
| Arrival structure | reservoir pre-wet, gorge progression | wave front with travel times (0→104 min down-trail) | radial blob |
| Mass balance | Q/V err ~1e-9 | stored/in = 1.0000 | 1.0000 |

## 4. Reading the Result Honestly

- **Near-field (0–1 km): MATCHED.** Depths agree to <1 m. The breach snap + wave trail put the right water in the right place at the dam.
- **Mid-field (1–3 km): UNDERSHOOT ~2–3x in depth, narrower.** Diffusive routing without momentum cannot sustain LISFLOOD's supercritical gorge jet; the wave attenuates faster.
- **Far-field (3–5 km): MISSED.** No momentum transport. For screening this is a *documented conservative gap in reach, non-conservative in near-field depth* — evacuation planning must use LISFLOOD (or HEC-RAS) extents, never the sandbox edge, for far-field decisions.
- **Rainfall:** no longer contaminates extent metrics at the default storm.
- **Determinism / performance:** bit-identical reruns; Tehri 96-grid run ≈ 0.4 s (conditioning ≈ 0.1 s); full backend suite 25/25 green.

## 5. Sensitivity Spot-Checks (Tehri, matched volume)

| Variant | In-domain area | Breach pile | Note |
|---------|---------------|-------------|------|
| burn cap 6 m, no ring | 1.22 km² | 94 m | slot trench, tower persists |
| burn cap 8 m + ring (adopted) | 1.25 km² | ~20 m | tower collapses |
| trail 12 → 20 → 28 cells | 1.90 → 1.98 → 1.98 km² | 21 → 15 → 14 m | diminishing returns past ~20 |
| smoothing fill for D8 (REJECTED) | — | — | fills the gorge with wall material (+30 m); reverted |

## 6. Limitations Statement

```
Screening model with river conditioning — NOT hydrodynamics/CFD/HEC-RAS.
Validated above against LISFLOOD-FP 5.9 on one dam (Tehri) and one scenario.
Operational use requires agency-authorized input data, calibrated parameters,
surveyed terrain/bathymetry, independent engineering review, and formal EAP
approval. Far-field reach is systematically short: use hydrodynamic extents
for any decision beyond ~2 km of the dam.
```

## 7. Recommendations

- [ ] Repeat this comparison for a plains dam (e.g. d16 Sardar Sarovar) where momentum matters less — expect closer agreement
- [ ] Re-run when surveyed bathymetry is available (DEM water surfaces are flat pool approximations)
- [ ] Consider a 1D channel + 2D floodplain coupled screen as the v3 step before full HEC-RAS rollout
