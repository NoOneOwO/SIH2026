# DamSafe Twin — Validation Report Template

## 1. Validation Overview

| Field | Value |
|-------|-------|
| Report Date | [DATE] |
| Prepared By | [NAME] |
| Dam | [DAM NAME] |
| Scenario | [FAILURE MODE — VARIANT] |
| Solver | [SOLVER VERSION] |

## 2. Analytical Benchmark (1D Dam-Break)

### Ritter Solution Comparison

Compare solver output against the analytical Ritter solution for 1D dam-break on flat bed.

| Metric | Solver Result | Analytical | Error |
|--------|--------------|------------|-------|
| Max depth at dam | [h0] m | [h0] m | 0% |
| Wave front position (t=60s) | [x_f] m | [x_f] m | [%] |
| Mass balance error | [%] | 0% | [%] |

## 3. Cross-Model Comparison

Compare against HEC-RAS / TELEMAC-2D reference results.

| Metric | DamSafe SWE | Reference | IoU / RMSE |
|--------|-------------|-----------|------------|
| Max flood extent | [area] km² | [area] km² | IoU: [0.xx] |
| Max depth (RMS) | [m] | [m] | RMSE: [m] |
| Arrival time error | [min] | [min] | MAE: [min] |

## 4. Sensitivity Analysis

| Parameter | Baseline | Variant A | Variant B | Impact |
|-----------|----------|-----------|-----------|--------|
| DEM resolution | 30m | 10m | 5m | [%] change in extent |
| Manning's n | 0.035 | 0.025 | 0.050 | [%] change in depth |
| Breach width | 150m | 100m | 200m | [%] change in peak flow |

## 5. Limitations Statement

```
This validation provides a planning and screening assessment. 
Operational use requires:
- Agency-authorized input data
- Calibrated model parameters  
- Surveyed terrain/bathymetry
- Independent engineering review
- Formal EAP approval
```

## 6. Recommendations

- [ ] Increase DEM resolution for operational use
- [ ] Calibrate Manning's n with field observations
- [ ] Cross-validate with HEC-RAS 2D results
- [ ] Conduct historical event reconstruction where data exists
