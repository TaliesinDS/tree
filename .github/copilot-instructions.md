# Copilot Instructions for Tree (Gramps Genealogy Viewer)

This file provides project-specific context for GitHub Copilot. It is automatically included in every Copilot chat for this workspace.

## Project Overview

**Tree** is a **view-only** genealogy browser that visualizes data exported from Gramps Desktop. It is NOT an editing platform.

- **Source of truth**: Gramps Desktop (export via `.gramps`/`.gpkg`)
- **Backend**: FastAPI + PostgreSQL/PostGIS (read-only API with server-side privacy enforcement)
- **Frontend**: Browser-based graph viewer using Graphviz WASM
- **Auth**: JWT cookie-based, multi-instance, role-based (admin/user/guest)

## Architecture Versions (IMPORTANT)

This repo contains **three architecture iterations**. Only v3 is actively maintained:

| Version | Path | Status |
|---------|------|--------|
| v1 | `/demo/graph`, `graph_demo.html` | **Legacy** - do not modify |
| v2 | `/demo/viewer`, `viewer_ported.html` | **Legacy** - do not modify |
| **v3** | `/demo/relationship`, `api/static/relchart/` | **Active** - all new work here |

When working on the viewer, **always use the relchart v3 files** under `api/static/relchart/`.

## Key Files (relchart v3)

### Frontend (no-build ES modules)
- `api/static/relchart/index.html` — UI shell
- `api/static/relchart/styles.css` — styling
- `api/static/relchart/js/app.js` — entrypoint + wiring (initialization)
- `api/static/relchart/js/api.js` — fetch wrappers for API endpoints (includes `withPrivacy()` helper)
- `api/static/relchart/js/state.js` — shared state + settings
- `api/static/relchart/js/util/clipboard.js` — clipboard helper
- `api/static/relchart/js/util/event_format.js` — event formatting helpers
- `api/static/relchart/js/chart/dot.js` — **DOT generation** (payload → Graphviz DOT string)
- `api/static/relchart/js/chart/render.js` — **SVG post-processing** (Graphviz SVG → interactive chart)
- `api/static/relchart/js/chart/graphviz.js` — Graphviz WASM loader
- `api/static/relchart/js/chart/panzoom.js` — viewBox-based pan/zoom
- `api/static/relchart/js/chart/payload.js` — payload merge utilities
- `api/static/relchart/js/chart/lineage.js` — **ancestor/descendant line tracing** for edge highlighting
- `api/static/relchart/js/features/import.js` — **in-browser import** (upload .gpkg/.gramps → server pipeline)
- `api/static/relchart/js/features/options.js` — **options menu** (privacy toggle, people list width)
- `api/static/relchart/js/features/auth.js` — **auth UI** (badge, logout, instance switcher, role gating)
- `api/static/relchart/js/features/userNotes.js` — **user notes** (per-person notes in detail panel)
- `api/static/relchart/js/features/guests.js` — **guest management** (create/delete guests in options menu)
- `api/static/relchart/js/features/mediaOverlay.js` — **media lightbox** (full-size image overlay with navigation)
- `api/static/relchart/js/features/mediaBrowser.js` — **media browser** (full-screen overlay with filters, grid, metadata sidebar)
- `api/static/relchart/js/features/media.js` — **media tab** (person detail panel thumbnail grid + portrait picker)

### Backend
- `api/main.py` — FastAPI app wiring (router registration + static mount)
- `api/routes/*.py` — route handlers (read-only endpoints)
- `api/routes/import_tree.py` — import upload + status endpoints
- `api/routes/auth.py` — login / logout / me / switch-instance endpoints
- `api/routes/user_notes.py` — user notes CRUD
- `api/routes/instance_members.py` — guest management per instance
- `api/routes/media.py` — media endpoints (list, detail, file serving, portrait override)
- `api/import_service.py` — import pipeline (Gramps XML → Postgres + media extraction)
- `api/auth.py` — password hashing, JWT helpers, `get_current_user()` dependency
- `api/middleware.py` — auth middleware (JWT validation, CSRF, instance resolution)
- `api/admin.py` — CLI admin tool (create-admin, create-instance, create-user)
- `api/db.py` — database connection helper (instance-aware `search_path`)
- `sql/schema.sql` — PostgreSQL schema (genealogy tables, per-instance)
- `sql/schema_core.sql` — core schema DDL (users, instances, memberships)

## Two-Phase Layout Architecture

The graph rendering has **two distinct phases**:

### Phase 1: DOT Generation (`dot.js`)
- Converts API payload (`{nodes, edges}`) into Graphviz DOT language
- Creates clusters for couples (`cluster_couple_<fid>`)
- Handles multi-spouse ordering, sibling grouping, single-parent families
- DOT is a **declarative constraint language** — Graphviz globally optimizes node positions

### Phase 2: SVG Post-Processing (`render.js`)
- Takes Graphviz SVG output and enhances it
- Adds click handlers, expand indicators, rim styling
- Moves/adjusts nodes (hubs, junctions) for visual polish
- Smooths edge paths (`convertEdgeElbowsToRoundedPaths`)

**Critical insight**: These phases have different capabilities:
- DOT constraints are **suggestions** to a global optimizer — they can be overridden
- SVG post-processing gives **direct control** but requires updating dependent geometry

## Hard-Won Lessons (from persistent bugs)

### 1. DOT is a Global Optimizer
Local node/edge attributes (`width`, `minlen`, etc.) can be overridden by:
- Conflicting subgraph constraints
- Global settings like `nodesep=0`
- Competing cluster pressures

**Implication**: For fine-tuned spacing, prefer SVG post-processing over DOT tricks.

### 2. SVG Movement Requires Edge Re-Snapping
If you move a node in SVG post-processing, **you MUST update edge endpoints** or edges will visually disconnect.

Pattern:
```javascript
// Track all movements
personDxById.set(nodeId, deltaX);

// Later, in edge smoothing:
if (personDxById.get(sourceId)) ends.source.x += personDxById.get(sourceId);
if (personDxById.get(targetId)) ends.target.x += personDxById.get(targetId);
```

### 3. Bounding Box Math in SVG
`getBBox()` **ignores transforms** — it returns local coordinates only.

**Correct approach** for user-space coordinates:
```javascript
const r = el.getBoundingClientRect();
const inv = svg.getScreenCTM().inverse();
// Transform screen coords back to SVG user-space via inv
```

### 4. Single-Parent Family Constraint Interference
When a person is both:
- A spouse in a two-parent family, AND
- The sole visible parent of a single-parent family

...DOT's constraint solver can compress the couple's horizontal spacing. This requires SVG-level correction (spouse nudging with edge re-snap).

### 5. Test with Specific Problematic Payloads
Generic test cases may not trigger constraint interference bugs. Always test with:
- `GET /graph/neighborhood?id=I0063&depth=5` (triggers F1592 edge case)
- Multi-spouse scenarios
- Single-parent families in view

## Graph Model

The API supports two graph shapes (prefer `family` for readability):

- `layout=family`: Family hub nodes (⚭) connect spouses and children
- `layout=direct`: Person-only graph with parent/partner edges (tangles more easily)

### Node Types
- **Person node**: `{ id, type: 'person', display_name, gender, birth, death, ... }`
- **Family hub**: `{ id, type: 'family', parents_total, children_total, has_more_children, ... }`

### Edge Types
- `parent`: person → family (spouse/parent relationship)
- `child`: family → person (child relationship)

## API Endpoints (commonly used)

```
GET /graph/neighborhood?id=<person_id>&depth=<n>&max_nodes=<n>&layout=family
GET /graph/family/parents?family_id=<fid>&child_id=<pid>
GET /graph/family/children?family_id=<fid>&include_spouses=true
GET /people/{id}
GET /people/search?q=<query>
POST /import                    — upload .gpkg/.gramps file
GET  /import/status             — poll import progress (idle/running/done/failed)
```

### Media endpoints
```
GET    /media                          — paginated media list (filter by q, mime, person_id)
GET    /media/{media_id}               — single media detail with references
GET    /media/file/thumb/{filename}    — serve thumbnail PNG (transparent)
GET    /media/file/original/{filename} — serve original file
GET    /people/{person_id}/media       — ordered media for a person (portrait + gallery)
PUT    /people/{person_id}/portrait    — set/clear portrait override { media_id }
```

### Auth endpoints
```
POST /auth/login                — { username, password } → sets tree_session + tree_csrf cookies
POST /auth/logout               — clears session cookie
GET  /auth/me                   — current user + instance info
POST /auth/switch-instance      — { slug } → switches active instance (admin only)
```

### Instance member endpoints
```
POST   /instances/{slug}/guests — create a guest account
GET    /instances/{slug}/guests — list guests
DELETE /instances/{slug}/guests/{user_id} — remove a guest
```

### User notes endpoints
```
GET    /user-notes              — list notes (optional ?gramps_id= filter)
POST   /user-notes              — create a note { gramps_id, body }
PUT    /user-notes/{id}         — update a note { body }
DELETE /user-notes/{id}         — delete a note
```

All graph and people endpoints accept an optional `privacy=off` query parameter
to bypass server-side redaction (used by the client-side privacy toggle).

## Privacy Model

Privacy is **enforced server-side** (anything sent to browser is public):
- `is_private` flag → always private
- `is_living_override` → explicit override from Gramps
- `is_living` flag → from Gramps export

**Privacy decision logic** (in order):
1. If `is_private` → private
2. If effectively living (has `is_living` flag or no death date):
   - Born on or after **1946-01-01** → private
   - Age < **90 years** → private
   - Otherwise → public
3. Unknown birth date with unknown living status → **private** (conservative)

Key constants in `api/privacy.py`:
```python
_PRIVACY_BORN_ON_OR_AFTER = date(1946, 1, 1)
_PRIVACY_AGE_CUTOFF_YEARS = 90
```

Private persons get `display_name: "Private"` and redacted dates.

### Client-Side Privacy Toggle

The Options menu includes a **Privacy filter** checkbox (default: ON).
- When unchecked, all API calls include `?privacy=off`, bypassing server-side redaction.
- An amber **"Privacy off"** badge appears in the top bar as a persistent indicator.
- The toggle is **never persisted** — refreshing the page resets privacy to ON.
- Toggling reloads the graph and invalidates cached sidebar data (people/families/events).
- Implementation: `api.js` exports `withPrivacy(url)` which appends `privacy=off` when the filter is disabled.

## Authentication & Multi-Instance Model

### Roles
- **admin**: Can create instances, manage all users, switch between instances. Sees instance picker after login.
- **user**: Owns one instance. Can import data, toggle privacy, manage guests. Auto-redirects to their instance.
- **guest**: Read-only access to one instance. Cannot import, toggle privacy, or manage guests. Auto-redirects.

### Auth Flow
1. All routes require authentication (except `/login`, `/auth/login`, `/auth/logout`, `/health`, static assets).
2. JWT stored in `tree_session` HttpOnly cookie (24h expiry, sliding refresh at 50%).
3. CSRF: double-submit cookie (`tree_csrf` readable by JS) + `X-CSRF-Token` header on mutating requests.
4. Rate limiting: 5 failed login attempts per IP per 5-minute window → 429.
5. Password validation: ≥8 chars, must contain uppercase + lowercase + digit.

### Multi-Instance Database Isolation
- Each instance gets its own Postgres schema (`inst_<slug>`).
- `db_conn(instance_slug)` sets `search_path TO inst_<slug>, _core, public`.
- Core tables (users, instances, memberships) live in `_core` schema.
- Genealogy tables (person, family, event, place, etc.) live per-instance.
- `user_note` table lives per-instance (survives re-imports).

### Admin CLI (`api/admin.py`)
```powershell
# Create admin user (also creates _core schema if needed)
.\\.venv\\Scripts\\python.exe -m api.admin create-admin --username admin --password Admin123

# Create an instance
.\\.venv\\Scripts\\python.exe -m api.admin create-instance --slug default --name \"Family Tree\"

# Create a regular user assigned to an instance
.\\.venv\\Scripts\\python.exe -m api.admin create-user --username alice --password Alice123 --instance default
```

### Frontend Auth Files
- `api/static/login.html` — login page
- `api/static/instance_picker.html` — instance picker (admin only)
- `js/features/auth.js` — auth badge, logout, role gating
- `js/features/guests.js` — guest CRUD in options menu
- `js/features/userNotes.js` — per-person notes (user/admin can write; guests read-only)

### In-Browser Import

The Options menu includes an **Import** section for uploading `.gpkg` / `.gramps` files:
- `POST /import` accepts the file upload and starts a background import thread.
- `GET /import/status` returns `{status: 'idle'|'running'|'done'|'failed', counts?, error?}`.
- The frontend polls `/import/status` every second and shows a blocking overlay.
- On completion, the graph auto-reloads.
- Max upload size: 200 MB.
- Backend: `api/routes/import_tree.py` + `api/import_service.py`.
- Frontend: `api/static/relchart/js/features/import.js`.

### Media System

Media images from Gramps exports are extracted, stored, and served by the app:

**Import pipeline** (`api/import_service.py`):
- Parses `<object>` and `<objref>` elements from Gramps XML
- Extracts image files from the `.gpkg` tar archive
- Generates 200×200 **PNG** thumbnails (preserving transparency for coat-of-arms / heraldry images)
- Records dimensions (`width`, `height`) in the `media` table
- Stores files in `api/media/<instance_slug>/original/` and `api/media/<instance_slug>/thumb/`

**Graph node portraits** (`dot.js` + `render.js`):
- Person nodes with a portrait get a wider card (`PERSON_CARD_WIDTH_PORTRAIT_IN = 2.60"` vs `1.80"`)
- The portrait image is placed to the left of the card text with a rounded-corner clip mask
- Aspect ratio handling: face photos (wider/square) use `xMidYMid slice` (crop to fill); tall images like coat of arms use `xMidYMid meet` (fit fully, no cropping)
- Text is shifted right during the text-positioning phase to stay within the right portion of the card
- The API sends `portrait_url`, `portrait_width`, `portrait_height` per person node

**Media browser** (`js/features/mediaBrowser.js`):
- Full-screen overlay opened from the topbar "Media" button
- Left sidebar: search filter (debounced), sort dropdown, item count, and metadata panel (preview, description, MIME type, dimensions, file size, checksum, referenced people/events/places)
- Right area: scrollable thumbnail grid with selection highlighting and "Load more" pagination
- Clicking a thumbnail selects it and loads detail in the sidebar; clicking the preview opens the lightbox
- Clicking a person reference closes the browser and navigates to that person in the graph

**Media tab** (`js/features/media.js`):
- Thumbnail grid in the person detail panel showing all media linked to the selected person
- Portrait picker: "Choose portrait" button enters selection mode; click a thumbnail to set as portrait
- Uses `PUT /people/{person_id}/portrait` to persist the choice (survives re-imports)

**Media lightbox** (`js/features/mediaOverlay.js`):
- Full-size image overlay with left/right navigation, keyboard support, and description caption

## Development Environment

- **OS**: Windows
- **Shell**: PowerShell (not bash)
- **Python**: Use `.venv\Scripts\python.exe` (not bare `python`)
- **API restart task**: "genealogy: restart api (detached 8081)"

### Quick Commands
```powershell
# Restart API
# Use VS Code task: "genealogy: restart api (detached 8081)"

# Or manually:
$env:DATABASE_URL = "postgresql://postgres:polini@localhost:5432/genealogy"
.\.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8081
```

### First-Time Auth Setup
```powershell
$env:DATABASE_URL = "postgresql://postgres:polini@localhost:5432/genealogy"
.\.\.venv\Scripts\python.exe -m api.admin create-admin --username admin --password Admin123
.\.\.venv\Scripts\python.exe -m api.admin create-instance --slug default --name "Family Tree"
```

## Testing the Viewer

1. Open `http://127.0.0.1:8081/demo/relationship`
2. Log in with admin credentials
3. Select an instance (admin) or auto-load (user/guest)
4. Click person cards to select, click family hubs to select (not expand)
5. Use expand indicators (▲/▼ tabs) to expand parents/children

## Bug Logs (historical reference)

- `docs/debug/FID_MISALIGNMENT_BUGLOG.md` — hub alignment/float issues (v1-v2 era)
- `docs/debug/F1592_COUPLE_SPACING_BUGLOG.md` — single-parent constraint interference (v3, resolved)

These contain detailed root cause analysis and failed approaches — consult before attempting similar fixes.

## What NOT to Do

- Don't modify legacy viewers (`viewer_ported.html`, `graph_demo.html`)
- Don't use `minlen=1` for horizontal spacing in DOT (it affects vertical rank)
- Don't move SVG nodes without tracking offsets for edge re-snapping
- Don't weaken single-parent anchoring edges (causes "float to top row" bug)
- Don't use `getBBox()` alone for cross-transform coordinate math

## Code Organization Rules (IMPORTANT — do not regress)

The codebase was refactored from "god files" into modules. **Do not undo this.**

### Backend: `api/main.py` is WIRING ONLY

`main.py` must stay small (~50 lines). It should only:
- Import routers from `api/routes/`
- Register routers with `app.include_router()`
- Mount static files

**Never add endpoint logic, database queries, or helper functions to `main.py`.**

When adding a new endpoint:
1. Create or use an existing file in `api/routes/` (e.g., `api/routes/people.py`)
2. Define your route handler there
3. Import and register the router in `main.py`

### Frontend: `app.js` is WIRING ONLY

`app.js` must stay small (~300 lines). It should only:
- Import feature modules
- Initialize features with `initXxxFeature()`
- Wire cross-feature callbacks
- Handle the initial page load

**Never add DOM manipulation, fetch logic, or rendering code to `app.js`.**

When adding a new feature:
1. Create a new file in `api/static/relchart/js/features/` (e.g., `features/newFeature.js`)
2. Export an `initNewFeature()` function and any needed helpers
3. Import and call it from `app.js`

### Module locations

| Type of code | Put it in |
|--------------|-----------|
| API fetch wrappers | `js/api.js` |
| Shared state/settings | `js/state.js` |
| DOT generation | `js/chart/dot.js` |
| SVG post-processing | `js/chart/render.js` |
| Graph interactions | `js/features/graph.js` |
| People sidebar | `js/features/people.js` |
| Families sidebar | `js/features/families.js` |
| Map tab | `js/features/map.js` |
| Detail panel | `js/features/detailPanel.js` |
| Import feature | `js/features/import.js` |
| Options/privacy toggle | `js/features/options.js` |
| Auth UI (badge, logout) | `js/features/auth.js` |
| User notes (detail panel) | `js/features/userNotes.js` |
| Guest management | `js/features/guests.js` |
| New backend endpoint | `api/routes/<domain>.py` |
| Auth routes (login etc.) | `api/routes/auth.py` |
| User notes CRUD | `api/routes/user_notes.py` |
| Instance member mgmt | `api/routes/instance_members.py` |
| Media routes | `api/routes/media.py` |
| Media lightbox (overlay) | `js/features/mediaOverlay.js` |
| Media browser (topbar) | `js/features/mediaBrowser.js` |
| Media tab (detail panel) | `js/features/media.js` |
| Auth helpers (JWT, hash) | `api/auth.py` |
| Auth middleware | `api/middleware.py` |
| Admin CLI | `api/admin.py` |
| Import pipeline | `api/import_service.py` |
| Privacy logic | `api/privacy.py` |
| Name formatting | `api/names.py` |
| Core schema (users etc.) | `sql/schema_core.sql` |

### Why this matters

Before refactoring, `app.js` was 5000+ lines and `main.py` was 3000+ lines. This caused:
- Regressions when adding features (everything touched everything)
- Fear of refactoring ("don't touch it")
- Bugs from load-order dependencies

The modular structure exists to prevent these problems. **Maintain it.**
