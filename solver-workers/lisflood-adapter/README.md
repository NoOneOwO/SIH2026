# LISFLOOD-FP adapter (DamSafe Twin)

Real hydraulic engine for DamSafe Twin's dam-break decision-support prototype.
No mock flood data anywhere in this path: terrain → engine → parsed rasters →
frontend overlay + impact ledger.

## Engine identity

- **LISFLOOD-FP 5.9**, University of Bristol lineage, via the OpenEarth fork
  (`https://github.com/openearth/lisflood-fp-bmi`), pinned commit
  `11f2a9214f80e1194bfaea23bc52a8247b9924ad` (see `Dockerfile` `LISFLOOD_REF`).
- Plain g++/OpenMP **CPU** build, ASCII I/O only. Local-inertia
  (`acceleration`) solver for dam-break runs.
- Reference for parameter conventions: `docs/PARAMETER_FILE.md` and
  `examples/dam_breach.par` of `urabbani/lisflood-fp_8.2_update`
  (DEMfile/startfile/weirfile/stagefile/resroot/saveint/sim_time/fpfric/
  voutput/initial_tstep — valid in both versions, verified against this
  5.9 source: `pars.cpp`, `input.cpp`, `output.cpp`).
- **Known limitation (documented, not hidden):** the pinned 8.2_update
  snapshot does not compile CPU-only (its `Arrays` struct uses
  `std::vector` while legacy `.cpp` files still do raw pointer arithmetic,
  plus unguarded CUDA includes). Hence 5.9, which builds cleanly.

## Build

```bash
docker build -f solver-workers/lisflood-adapter/Dockerfile \
    -t damsafe-lisflood:cpu solver-workers/lisflood-adapter
docker run --rm damsafe-lisflood:cpu -h
```

Image is ~120 MB (ubuntu:22.04 + libgomp).

## How the backend invokes it

`backend/app/lisflood/` stages a job dir `backend/sims/<job_id>/`:

```
sims/<job_id>/
  status.json      # queued/running/done/failed + honest progress
  metadata.json    # DEM identity, CRS, breach, gauges, request echo
  result.json      # parsed stats, impacts, downsampled grids (b64)
  inputs/
    dem.asc        # metric UTM crop of the repo DEM (Arc ASCII)
    reservoir.asc  # initial depths: reservoir polygon below level
    breach.txt     # static weir: "<x> <y> <W|E|N|S> Cd crest m width"
    gauges.stage   # exposure-point stage gauges (UTM metres)
    sim.par        # official-format parameter file
  outputs/
    res-*.wd       # depth slices at saveint (animation frames)
    res-*.Vx/.Vy   # velocity slices (voutput)
    res.max        # all-time max depth grid
    res.maxtm      # time-of-max grid (arrival proxy)
    res.maxVx/.maxVy
    res.stage      # gauge depth series (arrival truth per point)
    res.mass       # Time/Tstep/FArea/Vol/Qin/Qout/Qerror/Verror rows
  stdout.log / stderr.log
```

Execution: `docker run --rm -v <jobdir>:/work damsafe-lisflood:cpu -v
/work/inputs/sim.par` (arg list, no shell; server-side validated params).

## Terrain contract

- Source: `3d-assets/terrain-pipeline/output/<dam_id>/dem_raw.tif`
  (EPSG:4326 float32, ~30 m). Same dataset that feeds the GLB visualiser.
- Pass 1 (coarse) traces the downstream valley direction at the dam by
  steepest descent (8-ray max-drop fallback on flats).
- Pass 2 crops a square domain centred half a radius downstream, then
  reprojects to the dam's UTM zone (bilinear, nearest-valid void fill).
  Degrees are never treated as metres.
- Reservoir seeds water in the UPSTREAM 60° cone only (below the configured
  level), so the breach must route through the valley — no radial/backwards
  spreading. Breach weir axis follows the valley direction.
- A steepest-descent valley `flow_path` (lon/lat) is exported per job for the
  UI overlay. Result grids ship with `{crs, west, north, cell_m}` + dam UTM
  anchor so cells map onto the GLB local frame.

## Scenario → engine mapping (all validated server-side)

| Scenario param      | Engine input                                              |
|---------------------|-----------------------------------------------------------|
| dam                 | DEM crop + breach anchor at dam cell                      |
| reservoir level     | `reservoir.asc` depths (level − DEM, masked to radius)    |
| failure mode        | recorded; weir crest from breach depth (see below)        |
| breach width        | weir `Width` (m)                                          |
| breach depth        | weir `Crest_Elev` = dam-cell elev − depth                 |
| formation time      | STORED ONLY (v1 weir is static = instantaneous breach)    |
| duration            | `sim_time` (s)                                            |
| Manning's n         | `fpfric`                                                  |

## Outputs consumed

- `.wd` slices → animation frames; `.max` → max depth; `.maxtm` → arrival
  fallback; `.maxVx/.maxVy` (face → cell-centred) → speed; `.stage` →
  per-point arrival + series max (preferred over grid max, which can hold a
  sub-save-step weir-face transient); `.mass` → live progress
  (`Time/sim_time`) + mass-balance errors.
- Severity: dry <0.05 < low 0.3 < moderate 1.0 < high 2.5 < extreme (m).

## Failure policy

Any staging/engine/parse failure → `failed` + verbatim reason
(`SIMULATION FAILED — ...`), engine logs exposed. Never synthetic data.

## Troubleshooting

- `image 'damsafe-lisflood:cpu' not present` → build it (above).
- `docker ... not found / daemon unreachable` → start Docker Desktop.
- `reservoir_level_m ... below all terrain` → raise the level above the
  local valley floor (see `cell_elev_m` in metadata).
- `engine exited rc=...` → fetch `/lisflood/<job>/logs`.
- All-zero depths → reservoir never overtops the weir crest: level too low
  or crest too high; check `reservoir.wet_cells` in metadata.
