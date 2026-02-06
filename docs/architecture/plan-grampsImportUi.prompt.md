# Plan: Add “Import Gramps DB” via UI

## Goal

Add a minimal UI flow that lets an admin import a Gramps database file into the app, so the viewer can be updated without running local scripts manually.

Key requirements from discussion:
- Import happens through the UI (browser upload).
- Import is primarily used to replace an existing dataset with an updated one, but you also want the ability to host at least two unrelated trees side-by-side later.
- App remains read-only for genealogical data, except for a future sidecar notes system.
- User notes must survive re-imports by linking to Gramps IDs for primary entities.

## Current behavior (today)

### How data gets into the app

This project does not import through the API today. Instead, data ingestion is an offline pipeline:

1) Exporter reads a Gramps package/database file and produces JSONL export files  
- Exporter: [export/export_gramps_package.py](export/export_gramps_package.py)  
- Wrapper: [export/export_gramps_package.ps1](export/export_gramps_package.ps1)

2) Loader reads the JSONL export directory and loads it into Postgres tables  
- Loader: [export/load_export_to_postgres.py](export/load_export_to_postgres.py)  
- Wrapper: [export/load_export_to_postgres.ps1](export/load_export_to_postgres.ps1)

3) API serves whatever Postgres database `DATABASE_URL` points at  
- DB connection: [api/db.py](api/db.py)  
- Schema: [sql/schema.sql](sql/schema.sql)

### “Internal DB” clarification

The API does not create a separate internal database on its own. It reads from Postgres using `DATABASE_URL`. The loader assumes the database already exists and creates tables/extensions if needed.

## Target UX (minimal)

- Add an “Import Gramps DB” control to the relchart v3 UI (Options menu is a good home).
- Admin selects a file (`.gpkg` first; `.gramps` later).
- User sees a simple “Importing… app not ready” state while the import runs.
- When done, the UI can reload and display the newly imported dataset.

## Deployment modes to support

1) Local-only: webserver/app and the import file are on the same machine.
2) Hosted app: webserver/app is hosted; user uploads their Gramps DB from their machine.

This plan targets both by using browser upload (not server file paths).

## Phase 1: Single-tree “replace dataset” import (fastest)

### UI changes (relchart v3)

- Add UI elements in [api/static/relchart/index.html](api/static/relchart/index.html)
  - File input for `.gpkg`
  - Import button
  - Status text region (“Idle / Importing / Failed / Done”)

- Add DOM refs in [api/static/relchart/js/state.js](api/static/relchart/js/state.js)

- Add a new feature module, e.g. `initImportFeature()` under:
  - [api/static/relchart/js/features/](api/static/relchart/js/features/)

- Wire the feature from [api/static/relchart/js/app.js](api/static/relchart/js/app.js) (keep app.js wiring-only)

### Backend changes (new admin endpoints)

Create a new router file (example name):
- api/routes/import_admin.py

Register it in:
- [api/main.py](api/main.py)

Endpoints (minimal set):
- POST /admin/import
  - multipart upload (`UploadFile`)
  - runs import pipeline (export + load)
  - returns a job id or just “started”
- GET /admin/import/status
  - returns `idle | running | failed | done` and a last-error string

### Security model (Phase 1)

This must not be open to everyone on the network/internet.

Minimal admin gate:
- Require a shared secret token header such as `X-Admin-Token`
- Token stored in an env var on the server

Later phases can replace this with real login.

### Import orchestrator (server-side)

Create a small “import service” module that:
- Saves the uploaded file to a controlled import directory (no arbitrary paths)
- Runs exporter logic (from [export/export_gramps_package.py](export/export_gramps_package.py)) to a fresh export directory
- Runs loader logic (from [export/load_export_to_postgres.py](export/load_export_to_postgres.py)) into Postgres

Replace semantics:
- Run the loader with truncate semantics (equivalent of `--truncate`) so the DB matches the new export exactly and does not keep stale rows.

Operational constraints:
- Ensure only one import can run at a time (simple global lock)
- Enforce upload size limits and allowlist extensions
- Prefer `.gpkg` first to avoid archive extraction risks; add `.gramps` later with strong guardrails

## Phase 2: Make user notes survive re-import (sidecar notes keyed by Gramps ID)

Today, the API already exposes `user_notes: []` as a placeholder in the person payload:
- [api/routes/people.py](api/routes/people.py)

Add a real user-notes persistence layer that:
- Stores notes keyed by `tree` + `entity_type` + `entity_gramps_id` (example: `I0063`, `E0123`)
- Does not key on Gramps handles, since handles may change between exports

Leverage the existing ID resolution patterns:
- [api/resolve.py](api/resolve.py)

Goal:
- Re-importing updated data does not break note associations.

## Phase 3: Support multiple trees side-by-side (two access points)

You want at least two different trees with different access points and eventually different logins.

Recommended approach (minimize query rewrites):
- One Postgres database, one schema per tree (schema-per-tree)
- Set `search_path` per request based on the selected tree

Required work:
- Extend [api/db.py](api/db.py) so connections can set `search_path` based on the active tree
- Define how the active tree is selected:
  - URL prefix like `/t/{tree_slug}/...` is the simplest to reason about
- Import pipeline loads into a specific target schema for that tree
- Import into a staging schema first, then swap on success for atomic updates

Auth/authorization:
- Add a login system and authorize access to specific `tree_slug` values
- Until login exists, treat multi-tree access as “security by URL” only (not sufficient for real sharing)

## Verification checklist

Manual checks:
- Import a small `.gpkg` through UI; see “Importing…” then “Done”
- Reload viewer; graph renders from newly imported data
- Re-import updated file; verify data changes appear
- Once notes exist: add a note to person `Ixxxx`, re-import updated tree, verify note still attaches

Backend checks:
- Import endpoint rejects missing/invalid admin token
- Only one import runs at a time; concurrent requests return a clear error
- Status endpoint reflects running/failed/done

Network checks (hosted):
- Upload size limits enforced
- Server remains responsive during import (or clearly “busy”)

## Open decisions

- Multi-tree timing: start Phase 1 as single-tree replace-only, or build schema-per-tree immediately to avoid rework later.
- Supported formats: `.gpkg` only initially vs `.gpkg` + `.gramps` (archive handling needs strict hardening).
- Auth mechanism: simple shared admin token initially vs a real login from day one.
