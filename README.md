# 🛡️ DamSafe Twin

**Operational Emergency Action Plan and Real-Time Decision-Support Platform for Dam-Break Preparedness**

> Smart India Hackathon 2026 — Problem Statement SIH26161 (Dam Break Inundation Modelling)
> Sponsoring Organisation: National Technical Research Organisation (NTRO)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND (React + TypeScript)                                       │
│  CesiumJS globe · three.js terrain · Recharts charts                 │
│  Modules: Dashboard | Flood Impact | Incident Console |              │
│           EAP Dashboard | Alert Console | Evacuation Planner |       │
│           Report Generator | AI Assistant | Admin                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTPS / WebSocket
┌───────────────────────────────▼─────────────────────────────────────┐
│  BACKEND (FastAPI + Python)                                          │
│  Auth (Keycloak OIDC) · Scenarios · Simulation · Impact Analysis     │
│  GIS Pipeline · Reports (PDF) · Alerts · Audit Trail                 │
└───────────┬───────────────────────────────────────────┬─────────────┘
            │ Celery Workers                             │
            ▼                                            ▼
   ┌─────────────────┐                    ┌──────────────────────┐
   │ Redis (Broker)   │                    │ PostgreSQL + PostGIS │
   └─────────────────┘                    │ MinIO (S3)           │
                                          └──────────────────────┘
```

## 📁 Project Structure

```
damsafe-twin/
├── backend/                      # FastAPI Python backend
│   ├── app/
│   │   ├── main.py              # FastAPI entry point
│   │   ├── config.py            # Environment configuration
│   │   ├── database.py          # Async SQLAlchemy + PostGIS
│   │   ├── models.py            # ORM models (all tables)
│   │   ├── s3_client.py         # MinIO/S3 object storage
│   │   ├── worker.py            # Celery worker + tasks
│   │   ├── auth/                # OIDC + RBAC
│   │   ├── scenarios/           # Scenario lifecycle
│   │   ├── simulation/          # Solver orchestration
│   │   ├── impact/              # Hazard index, evacuation priority
│   │   ├── gis/                 # DEM conditioning, quality grading
│   │   ├── reports/             # PDF generation
│   │   ├── alerts/              # Draft/approve/dispatch gate
│   │   ├── audit/               # Immutable audit log
│   │   └── api/v1/              # REST routers
│   ├── migrations/              # Alembic migrations
│   ├── init_db.py               # Database init + seed data
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                     # React + TypeScript frontend
│   ├── src/
│   │   ├── main.tsx             # Entry point
│   │   ├── App.tsx              # Router
│   │   ├── api/client.ts        # API client
│   │   ├── types/index.ts       # TypeScript types
│   │   ├── i18n/                # EN + HI translations
│   │   ├── components/          # Layout, shared components
│   │   ├── modules/             # 8 routed frontend modules
│   │   │   ├── incident-console/ # globe + per-dam 3D terrain + simulation
│   │   │   ├── impact/           # flood-impact estimation workspace
│   │   │   ├── eap-dashboard/
│   │   │   ├── alert-console/
│   │   │   ├── evacuation-planner/
│   │   │   ├── report-generator/
│   │   │   ├── assistant/
│   │   │   └── admin/
│   │   └── viewers/
│   │       ├── gods-eye/        # Cesium globe (dam index, dive-to-dam)
│   │       └── local-3d/        # three.js terrain mesh + flood overlay
│   └── Dockerfile
├── solver-workers/               # Hydrodynamic solver adapters
│   ├── educational-swe/         # Educational 2D SWE solver
│   └── hecras-adapter/          # HEC-RAS adapter stub
├── 3d-assets/                    # 3D dam model pipeline
│   ├── procedural-generator/    # Path B: parametric mesh
│   └── cad-import/              # Path A: real geometry
├── infra/
│   └── docker-compose.yml       # Full stack orchestration
├── docs/
│   ├── provenance-schema.md
│   └── validation-report-template.md
└── README.md
```

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose
- Python 3.12+
- Node.js 20+

### 1. Start Infrastructure
```bash
cd damsafe-twin/infra
docker compose up -d postgres redis minio
```

### 2. Initialize Database
```bash
cd damsafe-twin/backend
pip install -r requirements.txt
python init_db.py
```

### 3. Start Backend
```bash
uvicorn app.main:app --reload --port 8000
```

### 4. Start Frontend
```bash
cd damsafe-twin/frontend
npm install
npm run dev
```

### 5. Full Stack (Docker Compose)
```bash
cd damsafe-twin/infra
docker compose up --build
```

**Access:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/api/docs
- MinIO Console: http://localhost:9001 (minioadmin/minioadmin)
- Keycloak: http://localhost:8080 (admin/admin)
- PgAdmin: http://localhost:5050

## 🌊 Flood Simulation — LISFLOOD-FP

DamSafe Twin runs **real hydraulic simulations** — no mocked flood results.
The engine is LISFLOOD-FP 5.9 (University of Bristol lineage, OpenEarth fork,
pinned; CPU build, ~120 MB image). The same repo DEMs that feed the 3D GLB
terrain drive the hydraulics.

```
REAL DEM (dem_raw.tif, EPSG:4326)
  → metric UTM crop around the dam (degrees never treated as metres)
  → LISFLOOD-FP (dam breach as a static weir + reservoir startfile)
  → REAL depth slices (.wd), max depth (.max), arrival (.maxtm/.stage),
    velocity (.maxVx/.maxVy), mass balance (.mass)
  → parsed stats + per-point impacts (villages/facilities)
  → 3D terrain overlay with time animation (Incident Console)
```

### Prerequisites

- Docker Desktop running; build once: `docker build -f
  solver-workers/lisflood-adapter/Dockerfile -t damsafe-lisflood:cpu
  solver-workers/lisflood-adapter`
- Backend venv needs `rasterio` + `scipy` (Windows wheels; already in the
  E-drive setup). No GDAL system install required.

### How it is invoked

`POST /api/v1/lisflood/run` (analyst role) validates the scenario
server-side, stages `backend/sims/<job_id>/` (`.par`/`.asc`/weir/gauges),
then runs `docker run --rm -v <jobdir>:/work damsafe-lisflood:cpu -v
/work/inputs/sim.par` (arg list, no shell). Poll `GET
/api/v1/lisflood/<job>` — routing progress comes from the engine's own
`.mass` Time column. `GET .../result` returns stats, impacts, grids and
animation frames; `GET .../logs` exposes engine stdout/stderr.

### Scenario parameters

Dam, failure mode, reservoir level (blank = illustrative default),
breach width/depth, formation time (**stored; v1 breach is static =
instantaneous**), duration, Manning's n, domain radius, cell size.
Open the Incident Console with a shareable result link:
`/incident?dam=<id>&lisflood=1&job=<job_id>` — it opens the dam's 3D terrain
with the hydraulic run panel on it.

### Incident Console simulation flow

One path to the terrain, one to run it: pick a dam in the sidebar, then
*View 3D terrain* or *Run screening simulation* in the dam panel. Both open
the same terrain (built on demand from real DEM + imagery when a dam has no
published mesh). The screening panel reports exactly what happened — running,
engine output on the terrain, or a failure with the backend start command.
With no backend running, *Load offline demo* replays the precomputed Tehri
bundle with no keys (`?sandbox=1`/`?demo=1`/`?direct=1` were removed).

### Terrain & result format

Source DEM per dam; simulation grid reprojected to the dam's UTM zone with
`{crs, west, north, cell_m}` recorded so result cells map onto the GLB
local frame. Result store layout (`metadata/inputs/outputs`, depth/
max-depth/velocity/arrival) is documented in
`solver-workers/lisflood-adapter/README.md`.

### Troubleshooting

Engine missing / daemon down / reservoir level below terrain / non-zero
exit / all-zero depths — each returns a specific error (never fake data);
see the adapter README. UI wording stays *"Simulation / Modelled
inundation / Decision-support prototype"* — never a validated prediction.

## 🔐 Official Access (Login / Verification)

DamSafe Twin is a restricted portal. Dam officials register at `/register`
with name, posting/designation, posted dam (dropdown) and an identity/posting
document (PDF/JPG/PNG ≤ 10 MB). Accounts start `pending`; an admin verifies
the document at `/admin` and approves. Seed admin: `admin@damsafe.local` /
`ChangeMe123!` (change immediately via `/auth/change-password`).

- Simulations you RUN are scoped to your posted dam (403 otherwise); you can
  still view every dam and ask the AI assistant about any of them.
- Admins see all users, documents and every staged simulation.
- Local JWT auth (`DAMSAFE_AUTH_SECRET`, 12 h) lives alongside the existing
  Keycloak/dev-bypass flow — nothing about it changed.

## 🤖 AI Assistant

`/assistant` — dam-aware chatbot plus simulation explainer.
- 12 major dams are briefed from a researched knowledge base
  (`backend/app/assistant/dams_kb.json`); all other dams fall back to registry
  facts. Set `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`/`OPENAI_MODEL`)
  for LLM answers, otherwise grounded KB/rules replies (labeled per message).
- `POST /api/v1/assistant/explain` turns real result numbers (LISFLOOD job or
  posted sandbox summary) into a headline, metric bullets and a phased
  preparedness plan. The LLM only rephrases — it never invents hydraulics.

## 🎯 Case Study: Machhu Dam, Morbi (Demo)

The MVP is pre-configured with a demonstration case study:

| Parameter | Value |
|-----------|-------|
| Dam | Machhu Dam (Demo — Morbi, Gujarat) |
| Type | Earthen Embankment |
| Height | 35.0 m |
| Crest Length | 1,600 m |
| Reservoir Capacity | 120 MCM |
| DEM | CartoDEM 30m (Prototype grade) |
| Scenarios | Overtopping (Expected) + Piping (Conservative) |
| Villages at Risk | 8 (including Morbi City, pop. 210,000) |

## 📡 API Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/v1/scenarios` | Create scenario | Operator+ |
| POST | `/api/v1/scenarios/{id}/submit` | Submit for approval | Analyst+ |
| POST | `/api/v1/scenarios/{id}/approve` | Approve + lock | Approver |
| GET | `/api/v1/scenarios/{id}/results` | Fetch precomputed layers | Viewer+ |
| POST | `/api/v1/sim-runs/{id}/enqueue` | Enqueue solver job | Analyst+ |
| GET | `/api/v1/impact/{id}/priority` | Evacuation priority list | Viewer+ |
| GET | `/api/v1/impact/{id}/roads?t=180` | Road passability at t=180m | Viewer+ |
| POST | `/api/v1/alerts/{id}/draft` | Generate alert | Operator+ |
| POST | `/api/v1/alerts/{id}/approve` | Human authorisation gate | Approver |
| POST | `/api/v1/alerts/{id}/dispatch` | Dispatch (blocked if not approved) | Approver |
| GET | `/api/v1/reports/{id}/pdf` | One-click EAP PDF | Viewer+ |
| GET | `/api/v1/audit` | Audit trail query | Analyst+ |

## 🔒 Security

- **AuthN:** Keycloak OIDC, MFA for approver/admin
- **AuthZ:** RBAC per route, DB CHECK constraints on approval gates
- **Audit:** Append-only `audit_log` with DB-level write protection
- **Human Gate:** Alert dispatch requires `approved_by IS NOT NULL` (enforced at DB level)

## 🌐 i18n

Bilingual support: English + Hindi for key screens and alert templates.

## 📊 Validation

- Analytical benchmark: 1D Ritter dam-break solution
- Cross-model comparison: IoU, RMSE, arrival-time error vs HEC-RAS/TELEMAC
- Sensitivity analysis: DEM resolution, Manning's n, breach parameters

## ⚠️ Disclaimer

> This demonstration provides a **planning and screening prototype**. Operational use requires
> agency-authorized input data, calibrated model parameters, surveyed terrain/bathymetry,
> independent engineering review, and formal EAP approval.

---

**Built for Smart India Hackathon 2026 | NTRO SIH26161**
