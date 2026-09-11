# DamSafe Twin — Data Provenance Schema

## Overview

Every result artifact in DamSafe Twin must carry a complete provenance chain.
No result exists without traceable inputs, model versions, and approval records.

## Required Provenance Fields

### Simulation Run Provenance

| Field | Type | Description |
|-------|------|-------------|
| `scenario_id` | UUID | Reference to the scenario definition |
| `dem_version_id` | UUID | DEM source, resolution, and conditioning record |
| `roughness_map_id` | UUID | Manning's n derivation record |
| `solver` | Text | Solver engine name |
| `solver_version` | Text | Exact solver version string |
| `breach_params` | JSONB | Breach geometry parameters (tagged as generator, not truth) |
| `boundary_conditions` | JSONB | Inflow hydrograph, initial water level |
| `mesh_config` | JSONB | Grid resolution, mesh type |
| `mass_balance_error` | Float | Percentage error in mass conservation |
| `within_tolerance` | Boolean | Whether mass balance is within 1% tolerance |
| `approved_by` | UUID | Approving engineer (non-null for approved scenarios) |
| `approved_at` | Timestamp | Approval timestamp |

### DEM Version Provenance

| Field | Type | Description |
|-------|------|-------------|
| `source` | Text | Data source (CartoDEM, Bhuvan, LiDAR, survey) |
| `resolution_m` | Float | Grid resolution in metres |
| `conditioning_steps` | JSONB | Processing log: sink fill, breaklines, channel burn |
| `quality_grade` | Text | Data quality classification |

### Data Quality Grades

| Grade | Description | Use Case |
|-------|-------------|----------|
| `prototype` | Screening-grade, unvalidated | Demo, education |
| `planning_grade` | Suitable for planning exercises | Preparedness |
| `engineering_reviewed` | Reviewed by qualified engineer | Pre-operational |
| `operationally_approved` | Formally approved for operations | Emergency response |

## Audit Trail

Every mutating action across all modules is recorded in the append-only `audit_log` table:

```sql
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_id UUID REFERENCES users(id),
    action TEXT NOT NULL,           -- "POST /api/v1/scenarios", etc.
    entity TEXT NOT NULL,           -- "scenario", "sim-run", etc.
    entity_id UUID,                 -- UUID of affected entity
    diff JSONB,                     -- Request/response details
    at TIMESTAMPTZ DEFAULT now()
);
```

The `audit_log` is append-only: `UPDATE` and `DELETE` are revoked at the database role level.

## Provenance in Reports

Every generated report includes a "Data Provenance & Limitations" section with:
- DEM source and resolution
- Quality grade
- Solver and version
- Mass balance error
- Approval chain
- Limitations disclaimer
