# Plan: Gramps DB Import + Multi-Tree Hosting

## Goal

Make this app usable in two modes from a single codebase:

1. **Local mode** - a Windows user runs the app to browse their own tree. No auth, no multi-tree. Works like today but with import via the UI instead of running scripts manually.
2. **Hosted mode** - a genealogist hosts 1-10 family trees on a server. Each tree is an isolated environment with two credentials (admin + guest). Families log in and see only their tree.

This is NOT a SaaS with many users. It is a small, private tool for genealogists to share their work with a handful of client families.

Key requirements from discussion:
- Import happens through the UI (browser upload).
- Import replaces an existing dataset with an updated one, or loads a new unrelated tree.
- App remains read-only for genealogical data, except for a future sidecar notes system.
- User notes must survive re-imports by linking to Gramps IDs for primary entities.
- Each tree has two credentials: admin (can import + view) and guest (view only).
- Single codebase, two modes: local (no auth) and hosted (auth + multi-tree).

## Two app modes (single codebase)

Controlled by a single env var: `TREE_MODE=local` (default) or `TREE_MODE=hosted`.

| Behavior | Local | Hosted |
|----------|-------|--------|
| Auth | None | Per-tree admin/guest passwords |
| Login screen | None (straight to viewer) | Yes (gates access) |
| Multi-tree | No (single tree in `public` schema) | Yes (schema-per-tree) |
| Import | Anyone with browser access | Admin role only |
| Deployment | `start_tree.ps1` / venv | `docker compose up` |

The core viewer, graph rendering, DOT generation, and API endpoints are identical across modes. The difference is: auth layer + multi-tree scoping + login UI.

## Current behavior (today)

### How data gets into the app

Data ingestion is an offline pipeline with no UI:

1. **Exporter** reads a Gramps file (`.gpkg` / `.gramps`) and produces JSONL files
   - Script: `export/export_gramps_package.py`
   - Dependencies: stdlib only (xml.etree, gzip, tarfile, zipfile) + psycopg (already in requirements)

2. **Loader** reads the JSONL directory and loads it into Postgres tables
   - Script: `export/load_export_to_postgres.py`
   - Applies schema DDL from `sql/schema.sql` on each run
   - Supports `--truncate` to replace all data cleanly

3. **API** serves whatever Postgres database `DATABASE_URL` points at
   - Connection: `api/db.py` - single `DATABASE_URL`, no schema/tenant awareness
   - All SQL queries use unqualified table names (e.g. `FROM person`), which is good for schema-per-tree later

### What is NOT in the app today

- No file upload endpoint (no `python-multipart` in requirements)
- No auth, sessions, or login
- No multi-tree / tenant concept
- No login screen in the frontend
- Dockerfile build context is `api/` only - excludes `export/` and `sql/` (cannot import in-container)
- No DB init on first `docker compose up` (empty database, no tables)

## Auth model (hosted mode only)

Each tree environment has exactly two credentials:

- **Admin** - can view the tree AND trigger import (upload/replace `.gpkg`)
- **Guest** - can only view the tree

This is NOT per-person user accounts. Think of it as "the Hofland family password" and "the Hofland admin password."

### Implementation approach

Config-driven, not a user-accounts table. A simple config (JSON file, env vars, or a small `tree_config` table) defines:

```
trees:
  hofland:
    label: "Familie Hofland"
    admin_password_hash: "..."
    guest_password_hash: "..."
  deheus:
    label: "Familie De Heus"
    admin_password_hash: "..."
    guest_password_hash: "..."
```

Session handling: Starlette's built-in `SessionMiddleware` with a signed cookie. No JWT, no bcrypt user tables, no OAuth. Just:
- Login page -> enter tree name + password -> get a session cookie with `{tree: "hofland", role: "admin"}` -> redirect to viewer.
- Session cookie scoped to the tree means all subsequent API calls know which schema to use and what role the caller has.

In **local mode**: no session, no middleware, all endpoints open, single tree in `public` schema.

## Tree lifecycle (hosted mode)

Before importing data, a tree environment must exist. This means:
- A Postgres schema named `tree_{slug}` has been created
- The tree is registered in the config (label + passwords)

How to manage trees:
- **CLI** (server admin): a management command like `python manage_trees.py create hofland --label "Familie Hofland" --admin-pass X --guest-pass Y`
- **Admin UI** (optional, later): a simple "manage trees" page behind a server-admin credential

For the MVP, CLI-only is fine. You are the only one creating trees.

## Phases

### Phase 0: Import via web UI (local mode, single tree, no auth)

Goal: replace the manual script workflow with a browser upload.

**Frontend**
- Add UI elements in `api/static/relchart/index.html`
  - File input (`.gpkg` initially; `.gramps` later with guardrails)
  - Import button
  - Status indicator ("Importing..." / "Done" / "Failed: reason")
- Add DOM refs in `api/static/relchart/js/state.js`
- New feature module: `api/static/relchart/js/features/import.js` with `initImportFeature()`
- Wire from `api/static/relchart/js/app.js` (wiring only)

**Backend**
- Add `python-multipart` to `api/requirements.txt` (required for `UploadFile`)
- New router: `api/routes/import_tree.py`, registered in `api/main.py`
- Endpoints:
  - `POST /import` - multipart upload, triggers import pipeline, returns status
  - `GET /import/status` - returns `idle | running | done | failed` + error string
- Import orchestrator (new module, e.g. `api/import_service.py`):
  - Saves upload to a controlled temp directory
  - Calls exporter logic from `export/export_gramps_package.py` directly as Python functions
  - Calls loader logic from `export/load_export_to_postgres.py` with truncate semantics into the `public` schema
  - Global lock: only one import at a time
  - Upload size limit + extension allowlist
- Make `export/` importable: add `export/__init__.py`

**UX during import**
- Show "Importing... app not ready" overlay, block normal interactions
- On completion, reload the viewer automatically

### Phase 1: Multi-tree foundation (schema-per-tree)

Goal: the app can hold multiple trees in one database, each in its own Postgres schema.

**Schema changes**
- Split `sql/schema.sql` into two parts:
  - `schema_extensions.sql` - one-time setup: `CREATE EXTENSION IF NOT EXISTS postgis` (runs in `public`)
  - `schema_tree.sql` - per-tree tables, indexes, triggers (runs in a target schema)
- Loader must accept a `target_schema` parameter and issue `SET search_path TO <schema>` before operating

**API changes**
- Extend `api/db.py`: `db_conn()` accepts an optional `tree_slug` parameter
  - If provided: `SET search_path TO tree_{slug}, public` on the connection
  - If not provided (local mode): use `public` schema as today
- All existing routes already call `with db_conn() as conn:` - they just need to pass the tree context through
- Tree context comes from:
  - **Local mode**: always `None` (public schema)
  - **Hosted mode**: derived from session cookie (`request.state.tree_slug`)

**Route scoping**
- Recommended: session-derived (same URLs as today, tree inferred from session cookie)
- This avoids touching every route registration; the session cookie already carries `tree_slug`
- A middleware or dependency extracts it and attaches to `request.state`

**Import changes**
- `POST /import` now targets the tree from the session (hosted) or `public` (local)
- Loader runs in the target schema

**Tree management CLI**
- `python manage_trees.py create <slug>` - creates schema `tree_<slug>`, runs `schema_tree.sql`, adds to config
- `python manage_trees.py delete <slug>` - drops schema, removes from config
- `python manage_trees.py list` - shows all trees

### Phase 2: Auth + login (hosted mode only)

Goal: gate access to trees behind admin/guest passwords.

**Backend**
- Add `itsdangerous` to requirements (for Starlette `SessionMiddleware` cookie signing)
- Add `SessionMiddleware` to FastAPI app (only when `TREE_MODE=hosted`)
- New router: `api/routes/auth.py`
  - `GET /login` - serves login page
  - `POST /login` - validates tree + password, sets session cookie, redirects to viewer
  - `POST /logout` - clears session
- Auth dependency: `get_current_session(request)` returns `{tree_slug, role}` or raises 401
  - In hosted mode: required on all data endpoints and import
  - In local mode: returns `{tree_slug: None, role: "admin"}` (everything allowed)
- Import endpoint: only allowed if `role == "admin"`

**Frontend**
- New: login page (`api/static/relchart/login.html` or a route-rendered template)
  - Simple form: select tree (dropdown), enter password, submit
  - On success: redirect to `/demo/relationship` (existing viewer)
- Viewer: if session is missing/expired, redirect to login
- Import UI: only visible when `role == "admin"` (pass role info via a `/me` or `/session` endpoint)

**Tree config storage**
- For MVP: a JSON file (e.g. `trees.json`) mounted as a volume in Docker, read by the API on startup
- Passwords stored as hashed values (use `hashlib.scrypt` or similar stdlib - no external library needed for this scale)
- Later option: move config to a `tree_config` table in Postgres `public` schema

### Phase 3: Containerization ("just deploy")

Goal: `docker compose up` gives you a fully working hosted instance.

**Dockerfile rework**
- Move build context to repo root in `api/docker-compose.yml`:
  ```yaml
  api:
    build:
      context: ..
      dockerfile: api/Dockerfile
  ```
- Update `api/Dockerfile` to selectively copy what is needed:
  - `api/` (app code + static files)
  - `export/` (import scripts)
  - `sql/` (schema files)
  - NOT: `docs/`, `tests/`, `reports/`, `.venv/`, `__pycache__/`
- Add `.dockerignore` at repo root

**DB init on first boot**
- Mount `sql/schema_extensions.sql` into Postgres `/docker-entrypoint-initdb.d/` so PostGIS extension is created automatically on first start
- OR: have the API apply extensions on startup (check + create if missing)

**Compose improvements**
- Remove `ports: "5432:5432"` from `db` service (Postgres should not be exposed to the network; the API container connects internally)
- Add volume mount for `trees.json` config file
- Add env vars: `TREE_MODE=hosted`, `SESSION_SECRET=<random>`, `DATABASE_URL` (already exists)
- Add healthcheck for API service

**Persistent storage**
- `pgdata` volume already exists (data survives container restarts)
- Import temp files: use a named volume or tmpdir inside the container (cleaned after import)

### Phase 4: User notes sidecar

Goal: users can annotate people/events with personal notes that survive re-imports.

**Schema**
- New table in a shared schema (e.g. `public` or a dedicated `sidecar` schema):
  ```
  user_note(
    id SERIAL PK,
    tree_slug TEXT NOT NULL,
    entity_type TEXT NOT NULL,      -- 'person', 'event', 'family'
    entity_gramps_id TEXT NOT NULL, -- 'I0063', 'E0123' (NOT handle)
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )
  ```
- Keyed by `gramps_id` (not Gramps handle) so notes survive re-imports where handles may change
- The `user_notes: []` placeholder already exists in `api/routes/people.py`

**API**
- New endpoints in `api/routes/notes.py`:
  - `GET /notes?entity_type=person&gramps_id=I0063` - get notes for an entity
  - `POST /notes` - create a note (admin only in hosted mode; anyone in local mode)
  - `DELETE /notes/{id}` - delete a note
- Resolution: use existing patterns from `api/resolve.py` to map between `gramps_id` and internal handles

**Frontend**
- Add a notes section to the detail panel (`api/static/relchart/js/features/detailPanel.js`)
- Show existing notes; allow adding new ones (if role permits)

## Technical prerequisites (discovered during research)

These are known issues that must be addressed during implementation:

| Issue | Where | Fix |
|-------|-------|-----|
| `python-multipart` not in requirements | `api/requirements.txt` | Add it (required for `UploadFile`) |
| `export/` not importable as package | `export/` | Add `__init__.py` |
| `schema.sql` path hardcoded in loader | `export/load_export_to_postgres.py` | Pass explicit path from orchestrator (parameter already exists) |
| Dockerfile build context too narrow | `api/Dockerfile` | Expand to repo root (Phase 3) |
| No `.dockerignore` | Repo root | Create one (Phase 3) |
| Postgres port exposed in compose | `api/docker-compose.yml` | Remove `ports:` for db service (Phase 3) |
| No DB init on first compose up | `api/docker-compose.yml` | initdb.d mount or API startup hook (Phase 3) |

## Verification checklist

### Phase 0 (import, local mode)
- Upload `.gpkg` through browser -> see "Importing..." -> data loads -> viewer reloads with new data
- Re-upload updated `.gpkg` -> old data replaced cleanly
- Concurrent import attempt shows clear error
- File size over limit is rejected

### Phase 1 (multi-tree)
- Create tree via CLI -> schema exists in Postgres
- Import into tree "hofland" -> data appears in `tree_hofland` schema
- Import into tree "deheus" -> different data in `tree_deheus` schema
- Viewer scoped to one tree sees only that tree's data

### Phase 2 (auth, hosted mode)
- Unauthenticated request -> redirected to login
- Guest login -> can view tree, cannot see import UI
- Admin login -> can view tree AND import
- Login for "hofland" -> cannot see "deheus" data
- Session expiry -> redirected to login

### Phase 3 (containerization)
- `docker compose up` from clean state -> working app with login page
- Import works inside container
- `docker compose down && docker compose up` -> data persists
- Postgres not reachable from outside the Docker network

### Phase 4 (notes)
- Add note to person I0063 in tree "hofland"
- Re-import "hofland" with updated `.gpkg` -> note still attached to I0063
- Note not visible when viewing tree "deheus"

## Decisions made

- Single codebase with `TREE_MODE` env var toggle (no fork)
- Auth is per-tree admin/guest passwords, NOT individual user accounts
- Tree config is file-based (JSON), not a database table (for MVP)
- Session via signed cookie (Starlette built-in), not JWT
- Schema-per-tree for isolation; tree identity derived from session (not URL prefix)
- Import replaces data (truncate + reload); no merge mode
- Containerization is part of hosted-mode work, not a separate concern
- `.gpkg` support first; `.gramps` archive support added later with hardening
- Notes keyed by `gramps_id` (not Gramps handle) to survive re-imports
