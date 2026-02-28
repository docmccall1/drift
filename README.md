# Drift 1.0 (Simulation-First Prototype)

Drift 1.0 is a local-first prototype that simulates six months of apparent real-time healthcare transactions for a 500-life employer cohort, computes weekly CDI drift scores, and renders role-based views for `Admin`, `Physician`, and `Patient`.

The project is fully runnable in simulation mode and includes an adapter boundary for swapping to eClinicalWorks live pulls later.

## Stack

- Backend: Node.js + TypeScript + Express
- Database: SQLite (`better-sqlite3`)
- Frontend: Single-page web UI (tabs by role)
- Tests: Vitest

## Features Implemented

- Deterministic seeded simulation with 500 lives and six-month timeline
- 90-day baseline window for patient-relative utilization/behavioral baselines
- Unified synthetic event stream with required event types:
  - `ClaimPosted`, `EncounterNoteSigned`, `ERVisit`, `HospitalAdmission`, `HospitalDischarge`
  - `PortalMessageSent`, `MedRefillRequest`, `MissedAppointment`
  - `LabResult`, `VitalReading`
- ICD-10 library and per-encounter/per-claim ICD arrays
- Drift engine with CDI 0-100 and bucket caps:
  - Utilization max 40
  - Behavioral max 30
  - Biometric max 20
  - Physician modifier max 10
- Weekly decay logic with slower severe-event decay
- Yellow confirmation window + velocity override
- Red Candidate workflow requiring review task outcome (`Confirm Red` or `Downgrade to Yellow`)
- Task queue automation:
  - Yellow confirmed -> outreach task (48-72h)
  - Red Candidate -> review task (24h)
- Role-based access:
  - Admin: aggregate metrics, queue/workload, simulation controls
  - Physician: panel-only patient list, explainability, note stub action
  - Patient: own stability color + 12-week trajectory + non-anxious explanation and check-in request
- Patient-facing responses never include cost fields
- Simulation controls (Admin):
  - Start / Pause / Resume
  - Speed slider
  - Jump to date
  - Reset seed
  - Export current visible events to CSV

## Repository Layout

- `/src/server.ts` - app bootstrap + static serving
- `/src/db.ts` - SQLite schema + init
- `/src/simulation/*` - deterministic generator, seeding, simulation clock
- `/src/drift/engine.ts` - CDI scoring + confirmation/decay logic
- `/src/services/*` - score recalculation, dashboards, task workflows
- `/src/adapters/*` - simulation adapter + live eCW adapter stubs (FHIR/vendor)
- `/src/api/*` - role-aware API routes and access checks
- `/src/public/*` - UI (Admin / Physician / Patient tabs)
- `/test/*` - drift engine unit tests

## Setup

1. Install dependencies:

```bash
npm install
```

2. Run in dev mode:

```bash
npm run dev
```

3. Open:

[http://localhost:4010](http://localhost:4010)

## Build + Run

```bash
npm run build
npm start
```

## Environment Variables

- `PORT` (default `4010`)
- `DB_FILE` (default `./drift.sqlite`)
- `SIM_SEED` (default `42`)
- `SIM_START_DATE` (default `2025-01-01`)
- `SIM_MONTHS` (default `6`)
- `SIM_DAYS_PER_SECOND` (default `0.44`)
- `YELLOW_THRESHOLD` (default `30`)
- `RED_CANDIDATE_THRESHOLD` (default `60`)

Adapter / live mode:

- `ADAPTER_MODE=simulation|live` (default `simulation`)
- `LIVE_CONNECTOR_TYPE=fhir|vendor` (default `fhir`)
- `ECW_BASE_URL`
- `ECW_CLIENT_ID`
- `ECW_CLIENT_SECRET`
- `ECW_TENANT`

No credentials are hardcoded.

## Switching Adapter Mode

Simulation mode (default):

```bash
ADAPTER_MODE=simulation npm run dev
```

Live mode with FHIR fetcher stub:

```bash
ADAPTER_MODE=live LIVE_CONNECTOR_TYPE=fhir ECW_BASE_URL=https://your-ecw.example.com npm run dev
```

Live mode with vendor endpoint stub:

```bash
ADAPTER_MODE=live LIVE_CONNECTOR_TYPE=vendor ECW_BASE_URL=https://your-ecw.example.com npm run dev
```

## API Notes

Key routes:

- `GET /api/meta/options` role selector data
- `GET /api/simulation/state`
- `POST /api/simulation/start|pause|resume|speed|jump|reset`
- `GET /api/simulation/export.csv`
- `GET /api/admin/dashboard?filter=all|diabetes|hypertension|uncategorized`
- `GET /api/admin/tasks`
- `POST /api/admin/tasks/:id/review`
- `GET /api/physician/panel`
- `GET /api/physician/patient/:id/explainability`
- `POST /api/physician/patient/:id/note-stub`
- `GET /api/patient/me`
- `POST /api/patient/me/request-checkin`
- `GET /api/integration/pulls?start=<iso>&end=<iso>`

Role is simulated via headers used by the UI:

- `x-role: admin|physician|patient`
- `x-actor-id: provider_id or patient_id`

## UI Page Description

- Admin tab: population CDI metrics, trend chart, risk-driver drilldowns, task workload, acceptance monitor, and simulation control panel.
- Physician tab: provider panel list with status/CDI/drivers/actions, newly-yellow list, red-candidate queue, and per-patient explainability timeline.
- Patient tab: personal stability color, 12-week trajectory graph, non-judgmental reason text, suggested actions, and request check-in button.

## Test

```bash
npm test
```

Included tests validate:

- Drift engine behavior
- Yellow confirmation window
- Velocity override behavior
- Weekly decay rules
