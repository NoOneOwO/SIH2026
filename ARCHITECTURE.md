# AquaShield 3D (DamSafe Twin) — Technical & Working Architecture

**Dam-Break Inundation & Emergency Decision Support System** — SIH 2026 prototype.
An end-to-end MVP: dam registry → condition assessment → breach scenario → 3D terrain
simulation → flood propagation → impact/priority analysis → evacuation corridors →
decision support.

> **Scientific posture (by design):** the flood engine is a *terrain-constrained
> screening model*, not hydrodynamics/CFD/HEC-RAS. Every modelled number is labelled
> (Simulated / Estimated / Projected), carries an evidence class, and uncertainty is
> shown as scenario spreads — never as a certified prediction.

---

## 1. Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, Vite (`:3000`), Tailwind (`cmd-*` tokens), motion, recharts, lucide-react, react-router v6, i18next (en/hi) |
| 3D viewers | **three.js** (local terrain meshes, OrbitControls, vertex-color flood paint), **Cesium** (God's Eye globe), MediaPipe Tasks-Vision (hand-gesture camera) |
| Backend | FastAPI (uvicorn `:8000`), Pydantic v2, SQLAlchemy async + **PostGIS**, GeoAlchemy2 |
| Async / classic path | Celery worker + Redis (`:6379`); LISFLOOD-FP job staging (real hydraulics, optional path) |
| Storage | PostgreSQL/PostGIS (`:5433`, docker `infra-postgres-1`), MinIO S3 (`:9000-9001`), local JSON file stores, terrain asset tree |
| Geodata | Copernicus GLO-30/GLO-90 → CDSE SRTM → OpenTopography (DEM provider chain), OpenStreetMap Overpass (assets + roads, 30-day cache), Esri World Imagery (textures + basemap), Cesium ion |
| Documents | pypdf (text extraction), reportlab/weasyprint (EAP PDF reports) |
| Auth | Local HS256 JWT (bcrypt, 12 h) + optional Keycloak OIDC; RBAC hierarchy; dev-token bypass in DEV |
| Deploy | render.yaml (backend), frontend on Vercel, GitHub Actions keep-alive cron, `start.bat`/`start.sh`, `infra/docker-compose.yml` |

---

## 2. System context

```
                       ┌──────────────────────────────────────────────┐
                       │                 BROWSER (SPA)                │
                       │  Vite dev server :3000  (static + /api proxy)│
                       └───────┬───────────────────────┬──────────────┘
              /api/v1/*  → :8000│                       │  /terrain/*.glb (static)
                       ┌────────▼───────────────────────▼──────────────┐
                       │              FastAPI  app.main               │
                       │  api_router (prefix /api/v1) + AuditMiddleware│
                       └──┬──────┬──────┬──────┬──────┬──────┬─────────┘
          ┌───────────────┘      │      │      │      │      └────────────────┐
          ▼                      ▼      ▼      ▼      ▼                       ▼
   ┌─────────────┐      ┌────────────┐ ┌─────┴─────┐ ┌──────────┐    ┌──────────────┐
   │ sandbox     │      │ impact     │ │ damprofile│ │ dams     │    │ lisflood /   │
   │ (screening  │      │ estimation │ │ profiles/ │ │ registry │    │ celery worker│
   │  engine)    │      │ evacuation │ │ documents │ │ summary  │    │ (classic SWE │
   └──────┬──────┘      └─────┬──────┘ │ condition │ └────┬─────┘    │  + LISFLOOD) │
          │                   │        └─────┬─────┘      │          └──────┬───────┘
          ▼                   ▼              ▼            ▼                 ▼
   terrain tree         Overpass OSM   backend/data/  PostGIS dams     Postgres SimRun
   (DEMs, GLBs)         (assets+roads) dam_profiles/  + registered     grids, reports,
   provider chain                      registered_    dams.json        alerts, audit
   Copernicus/CDSE/OT                  dams.json
          │
          ▼
   frontend/public/terrain/<id>.glb + manifest.json  (served to three.js)
```

---

## 3. Repository layout (working code)

```
SIH2026/
├─ backend/
│  ├─ app/
│  │  ├─ main.py                 FastAPI entry (CORS, audit middleware, lifespan)
│  │  ├─ config.py / database.py / models.py   settings, async engine, ORM+PostGIS
│  │  ├─ api/
│  │  │  ├─ __init__.py          aggregates every router under /api/v1
│  │  │  └─ v1/{dams,scenarios,sim_runs,impact,alerts,reports,audit,gis,sandbox}.py
│  │  ├─ sandbox/                ★ synchronous numpy simulation world
│  │  │  ├─ dam_registry.py      canonical 50-dam registry (+runtime registrations)
│  │  │  ├─ terrain.py           DEM locate/resolve/load_elevation, available_dams()
│  │  │  ├─ terrain_providers.py ensure_dem provider chain (never synthetic)
│  │  │  ├─ terrain_capture.py   on-demand GLB build + publish to frontend
│  │  │  ├─ engine.py            diffusive screening propagation (v2)
│  │  │  ├─ rivers.py            D8 conditioning: burn channels, snap breach
│  │  │  ├─ hydrograph.py        broad-crested-weir breach hydrograph
│  │  │  ├─ scenarios.py         deterministic best/likely/worst + ensemble agent
│  │  │  ├─ ensemble.py          per-cell scenario aggregation + exposure classes
│  │  │  ├─ assets.py            OSM settlements/facilities (cache; modeled fallback)
│  │  │  ├─ impact_run.py        run_case(): generate→simulate→estimate bridge
│  │  │  ├─ explainer.py         rules-based decision insights
│  │  │  └─ response.py / schemas.py / router.py
│  │  ├─ impact/
│  │  │  ├─ estimation.py        HAZARD→…→AVOIDED-LOSS chain + priority + assets
│  │  │  ├─ grids.py             grid codec, lat/lon sampling, b64 float32
│  │  │  ├─ evacuation.py        OSM road sampling → corridors/unsafe/safe sectors
│  │  │  └─ service.py           classic-path (SimRun grids) analytics
│  │  ├─ damprofile.py           profiles, document upload+extraction, condition
│  │  ├─ auth/{service,local}.py RBAC + local JWT + registration/approval
│  │  ├─ assistant/              AI assistant (dams_kb.json, context handoff)
│  │  ├─ lisflood/               real hydraulic job staging (LISFLOOD-FP)
│  │  ├─ worker.py               Celery classic-path solver
│  │  └─ alerts/ reports/ audit/ EAP PDFs, alert drafts, audit log
│  ├─ tests/                     79 pytest tests (engine, API, MVP decision support)
│  └─ data/                      users.json, dam_profiles/, registered_dams.json
├─ frontend/
│  ├─ src/
│  │  ├─ api/client.ts           single typed HTTP client (auth header injection)
│  │  ├─ modules/                route screens: incident-console, impact, admin, …
│  │  ├─ components/impact/      views.tsx, decision.tsx, primitives, format
│  │  ├─ components/admin/       DamRegistry.tsx (table + drawer + register form)
│  │  ├─ viewers/gods-eye/       Cesium globe (basemaps, sensors, risk+evac layers)
│  │  ├─ viewers/local-3d/       three.js terrain mesh, flood paint, hand control
│  │  ├─ data/india-dams.ts      curated 50-dam dataset (mirrors backend registry)
│  │  └─ types/impact.ts         estimate payload contracts
│  └─ public/terrain/            <dam>.glb/.metadata.json/.transform.json + manifest
├─ 3d-assets/terrain-pipeline/   curated DEM/GLB pipeline (output/<dam_id>/…)
└─ infra/, scripts/, render.yaml, start.{bat,sh}
```

---

## 4. API surface (`/api/v1`)

| Group | Endpoints (method path → purpose) |
|---|---|
| **sandbox** | `GET /sandbox/dams` — registry dams with `terrain_ready` · `POST /sandbox/scenarios/generate` — best/likely/worst + ensemble params (inputs only) · `POST /sandbox/run` — full run: grids + hydrograph + frames + assets + impact estimate + explanation · `POST /sandbox/ensemble` — N runs aggregated · `GET /sandbox/terrain/{id}/status`, `POST /sandbox/terrain/{id}/capture` — on-demand 3D terrain · `GET /sandbox/demo/tehri` — offline precomputed bundle |
| **impact** | `POST /impact/estimate` — transparent estimate chain (`compare_all: true` → best/likely/worst totals spread) · `GET /impact/{sim_run_id}/priority|roads|hazard|facilities` — classic-path analytics |
| **dams** | `POST /dams` — register dam (DB row + registry entry) · `GET /dams/registry/summary` — admin table (docs, completeness, condition, simulation availability) · CRUD `/dams/{id}` |
| **dam profiles** | `GET/PUT /dams/{id}/profile` · `POST /dams/{id}/documents` (upload+extract) · `GET /dams/{id}/documents/{doc}/file` · `GET /dams/{id}/condition` — explainable assessment |
| **auth** | `POST /auth/register|login|change-password` · `GET /auth/users` · `POST /auth/users/{id}/approve|reject` · `GET /auth/sims` |
| **scenarios / sim-runs** | scenario lifecycle (draft→submitted→approved→locked), run enqueue/status (classic path) |
| **alerts / reports** | EAP PDF per sim run, alert draft→approve→dispatch, broadcast inbox |
| **assistant / lisflood / audit / gis** | AI Q&A over runs; LISFLOOD job run/status/result; audit query; DEM versions, Manning's n |

All responses carry honest `mode` strings (`REAL COMPUTED SIMULATION (screening model)…`,
`OFFLINE DEMO (precomputed…)`), provenance blocks and warnings.

---

## 5. Simulation pipeline (sandbox screening engine)

```
ScenarioParams (breach width/depth/severity, release m³, roughness n,
                rainfall ×, duration, seed — INPUTS ONLY)
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. TERRAIN        load_elevation(dam, grid)                   │
│    dem_raw.tif (curated tree or provider chain cache)         │
│    → rasterio resample to N×N (64/96/128), nodata fill        │
├───────────────────────────────────────────────────────────────┤
│ 2. RIVER CONDITIONING (rivers.py)                             │
│    D8 flow accumulation → burn channels, snap breach to the   │
│    channel at the dam, sill carve, wave-inflow cells          │
├───────────────────────────────────────────────────────────────┤
│ 3. BREACH HYDROGRAPH (hydrograph.py)                          │
│    broad-crested-weir growth, volume-normalized,              │
│    formation time by severity (partial/major/full)            │
├───────────────────────────────────────────────────────────────┤
│ 4. PROPAGATION (engine.py, "sandbox-diffusive-screening-v2")  │
│    terrain-constrained diffusive routing, Manning-analogue    │
│    friction, split channel/floodplain conveyance,             │
│    rainfall − soil abstraction, deterministic (seeded)        │
│    → arrival_min[N,N]  maxdepth_m[N,N]  frames (~24 checks)   │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
Transport: base64 float32 grids + bbox_wsen + hydrograph + frames
           (row 0 = north; every consumer documents this convention)
```

**Scenario agent** (`scenarios.py`): deterministic seeded generator → `best/likely/worst`
triplet + N-scenario ensemble. **Ensemble** (`ensemble.py`): per-cell share of scenarios
that inundate (`exposure_pct`), earliest/median/worst arrival grids; exposure classes
≥70 % High-confidence / 40–70 % Probable / <40 % Low-probability — *scenario frequency,
never statistical probability*.

---

## 6. Impact decision chain (`impact/estimation.py`)

```
HAZARD ──► EXPOSURE ──► VULNERABILITY ──► IMPACT ──► ECONOMIC LOSS ──► AVOIDED LOSS
engine       settlements   population      exposed/       ₹ per person,        early-action
grids        + assets      (OSM tag or     displaced      facility unit        effectiveness
sampled      sampled       class median)   people         rates × depth-       by lead time
3×3 cells    vs footprint                  & assets       damage curves        + mobilisation
```

Every published value carries an **evidence class**: `observed` (OSM tags, DEM samples),
`derived` (arithmetic), `modelled` (simulation/documented model), `assumed` (published
planning parameters — all listed in the payload's `assumptions` block). Outputs include
`confidence` (100 − Σ input-quality penalties + ensemble bonus), `drivers`,
`limits`, and per-settlement rows with ranges (never a bare mid).

### Population-at-Risk priority (deterministic, explainable)
`score 0–100 = population 40 (log, saturates 50k) + depth 20 + arrival 20 +
evacuation access 10 + facilities 10` → **LOW <30 · MEDIUM <50 · HIGH <70 · CRITICAL ≥70**,
with a `reasons[]` list citing the exact value each component scored. SAFE settlements
score 0. *Not a casualty estimate — a response-ordering aid.*

### Asset exposure
Every mapped critical facility (hospital, school, police, fire, power, bridge, telecom)
gets distance-from-breach (derived), modelled depth/arrival, flood-risk band, status
EXPOSED/DRY and reasons.

### Evacuation screening (`impact/evacuation.py`)
```
Overpass (motorway…tertiary + bridges, ~12 km, 30-day cache, app User-Agent)
   → sample modelled depth/arrival along each polyline
   → FLOODED ≥0.5 m · RESTRICTED ≥0.15 m · USABLE (or OUTSIDE_DOMAIN — never "safe")
   → per exposed settlement: nearest USABLE road ⇒ CANDIDATE corridor
        distance, ~travel time @ 40 km/h (documented assumption),
        safe bearing away from the dam, status RECOMMENDED CANDIDATE / MARGINAL / NO CANDIDATE
   → bottlenecks (flooded bridges), safe-zone bearing sectors (no modelled water)
   → fallback: Overpass down ⇒ data_source:"unavailable" + honest note (never a crash)
```

### Decision summary (`decision_summary`)
WHERE / WHEN / WHO / WHY — pure text assembly over computed values ("Every statement
cites computed values from this assessment; nothing here is an independent prediction.").

---

## 7. Terrain system

**Two independent products share one DEM source:**

1. **Sim grids** — `load_elevation(dam, grid)` resamples `dem_raw.tif` on demand.
   Missing DEMs are auto-acquired by the provider chain
   (`local → Copernicus GLO-30 → GLO-90 → CDSE SRTM → OpenTopography`; cached into
   `dem_cache/`; *never synthetic*) — a known dam 404s only if truly unknown, and 503s
   with the attempt trail if every provider fails.
2. **3D meshes** — `terrain_capture.py` builds a 129×129 GLB (±5 km, real DEM + Esri
   World Imagery texture, trimesh PBR), writes `transform.json` (ENU→ECEF modelMatrix)
   + `metadata.json` (mesh_grid rows/cols), publishes into `frontend/public/terrain/`
   and upserts `manifest.json` (utf-8-sig, id-keyed). Frontend `ensureTerrain()`
   captures on first request for any dam, then the flow continues transparently.

`GET /sandbox/dams` lists **registry dams only** (never raw terrain folders — stale
folders from an older dataset once leaked as `dNNN (dNNN)` and 404'd on run), each with
`terrain_ready`.

---

## 8. Frontend architecture

```
App (router, auth context, i18n)
├─ /incident  IncidentConsole ─ dam sidebar (50, height buckets, screening dot)
│    ├─ God's Eye globe (Cesium): ESRI/OSM/ION basemaps, Normal/Night/NVG/Thermal/Noir
│    │    sensors, OSM surroundings, quakes/flights, share links, ?globeCity waypoints
│    │    + impact risk layer (settlement markers, modelled zones)
│    │    + evacuation overlay (green dashed corridors, red unsafe roads)
│    ├─ Local3DView (three.js): GLB terrain, OrbitControls, dam pin, OSM buildings/
│    │    trees/roads tinted live by flood state, hand-gesture camera, spin-on-busy
│    ├─ SandboxPanel: scenario inputs, agent cases, ensemble, timeline with T+ ticks,
│    │    danger index, priority zones, hydrograph/area charts, honest status states
│    └─ LisfloodPanel (FEATURES.lisflood): real-hydraulics runs (geo grid binding)
├─ /impact    ImpactIntelligence ── 6 tabs
│    Overview (decision card + metrics) · Live map (globe + detail drawer) ·
│    Impact (asset exposure + all settlements + loss breakdown) ·
│    Population at risk (priority bands + expandable WHY) ·
│    Evacuation (scenario spread + corridors + unsafe roads + safe sectors) ·
│    Data & confidence (assumptions, method chain, limits)
├─ /admin     Verification queue · **Dam registry** (table → profile drawer with
│             document upload/view + extracted findings + condition evidence +
│             Run sandbox / Flood impact jump-offs) · Register-dam form · Sim ledger
└─ /dashboard /eap /alerts /evacuation /reports /assistant  + /login /register
```

**Core journey (kept obvious, per MVP constraint):**
`SELECT DAM → REVIEW DAM RISK → RUN SANDBOX → WATCH FLOOD PROPAGATION → VIEW FLOOD
IMPACT → SEE WHO/WHAT IS AT RISK → VIEW EVACUATION OPTIONS`.
The sandbox's "Open the decision-support dashboard" deep-links
`/impact?dam=<id>&case=<case>` when the run completes.

---

## 9. Auth, roles & tenancy

- **Local auth** (`auth/local.py`): officials register with posting dam + identity
  document (≤10 MB) → `pending`; admin approves → HS256 JWT (12 h) with
  `{role, dam_id, status}`. Seed admin `admin@damsafe.local` created on first use.
- **RBAC hierarchy**: viewer(0) < operator(1) < official/analyst(2) < approver(3) <
  admin(4); `require_role()` guards every router; officials are dam-scoped for RUN
  endpoints (`require_dam_scope`); document uploads: officials → their posting dam,
  analyst+ → any dam.
- **DEV bypass**: `dev-token` (or absent header in ENVIRONMENT=development) → admin
  DevUser. Frontend injects it automatically in DEV.
- Optional Keycloak OIDC path retained in `auth/service.py`.

---

## 10. Data stores

| Store | What lives there |
|---|---|
| **PostGIS** (`infra-postgres-1`, host port 5433) | `dams` (PostGIS points), scenarios, sim_runs (classic-path grids in `result_layers` JSONB), villages/facilities/roads/shelters, road_status, evacuation_priority, alert_drafts, audit_log |
| **JSON file stores** (`backend/data/`) | `users.json` (local auth), `registered_dams.json` (runtime registrations), `dam_profiles/<id>/{profile,documents}.json` + uploaded files |
| **Caches** (`backend/app/sandbox/assets_cache/`) | per-dam OSM assets (`<id>.json`), OSM roads (`<id>.roads.json`) — 30-day TTL |
| **Terrain trees** | curated `3d-assets/terrain-pipeline/output/<id>/dem_raw.tif…`; provider cache `backend/app/sandbox/dem_cache/`; published meshes `frontend/public/terrain/` |
| **Redis / MinIO** | Celery broker; S3 bucket for DEM versions / 3D models / documents (classic path) |
| **Offline demo** | `backend/app/sandbox/demo_cache/tehri_demo.json`, also copied to `frontend/public/demo/` (works with no backend/API keys) |

---

## 11. Classic (async) path — how it differs

The synchronous sandbox is the interactive path. A second, DB-backed path exists for
operational workflows: **Celery worker** solves the educational SWE model, embeds
result grids (base64 float32 + `grid` anchor, `screening-1d-downstream` mapping) into
`SimRun.result_layers`; `impact/service.py` then computes evacuation priorities, road
passability at time t, hazard summaries and facility exposure by sampling those grids
(`impact/grids.py`). Scenario rows carry solver/approval provenance. **LISFLOOD-FP**
jobs stage a real hydraulic solver in `backend/sims/<job>/` with logs/metadata and a
geo-bound result grid (`FloodGeo` UTM frame) consumed by `Local3DView.geoCellForVertex`.

---

## 12. End-to-end request walkthroughs

**A. Run the sandbox (one click):**
`EnterTerrain(dam,'run')` → ensure GLB → `POST /sandbox/run {dam_id, scenario, grid:96}`
→ backend resolves dam+terrain, conditions rivers, runs engine (~seconds) → response
with grids+frames+hydrograph+assets+`impact_estimate`+`explanation` → frontend paints
flood via vertex colors, starts timeline playback, spin stops, results auto-scroll →
optional jump to `/impact?dam=…`.

**B. Impact assessment:**
`POST /impact/estimate {dam_id, case:'likely', grid_size:64, ensemble_count:8,
compare_all:true}` → `run_case`: triplet scenario → engine on 64² grid → ensemble runs
→ OSM assets (cache/live/modeled fallback) → estimation chain (settlements, priority,
assets, evacuation via cached roads, decision summary) → totals with ranges +
confidence → `scenario_comparison` (3 full runs). UI renders the six tabs from this
single payload; the globe layers (risk + evacuation) read the same data.

**C. Dam onboarding:**
`POST /dams` (form) → DB row + registry entry (`r<id>`) → appears in Admin registry &
Flood Impact dropdown → officials upload inspection PDFs → extraction structures
findings → `GET /condition` returns evidence-backed category → "Run sandbox" builds
terrain via the provider chain on first use.

---

## 13. Verification & operations

- **Tests:** 79 pytest — engine determinism/physics sanity, scenario-agent honesty,
  API validation, registry consistency, priority determinism/banding, evacuation
  graceful fallback (mocked Overpass), document extraction, condition categories,
  registry-summary contract.
- **Typecheck:** `cd frontend && npx tsc -b` (clean).
- **Local run:** `infra` containers (postgres/redis/minio) →
  `uvicorn app.main:app --port 8000` → `npm run dev` (:3000) → health `/health`.
- **Deep links:** `?dam=<id>`, `?lisflood=1&job=<id>`, `?globeCity=…`, `?dam=…&case=…`.
- **Known limits (published in-UI):** screening engine ≠ hydrodynamics; population only
  as good as OSM coverage; unit rates are planning-level; no single number is a forecast.

---

## 14. Design invariants (do not break)

1. **Nothing invented:** every figure traces to engine output, a DEM sample, a real OSM
   tag, or a published assumption — missing data is *reported*, never filled.
2. **Evidence classes travel with values**; the UI renders them next to numbers.
3. **Registry is canonical:** dam ids/coords/names come from `dam_registry.py`
   (mirrored by `india-dams.ts`); terrain folders are assets, never an inventory.
4. **Grids are row0=north** with `bbox_wsen`; b64 float32 is the transport codec.
5. **Deterministic scenarios** (seeded) — same dam+seed ⇒ same outputs, everywhere.
6. **Screening labels stay on** (`REAL COMPUTED SIMULATION (screening model)`, modelled
   chips, candidate-corridor disclaimers, evidence-bookkeeping condition badges).
7. **Additive evolution:** new capabilities extend the estimate payload and add tabs —
   existing working features are never removed.
