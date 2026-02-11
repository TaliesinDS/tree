# Genealogy dev runbook

This repo is designed to run locally on Windows (PowerShell), backed by Postgres + PostGIS.

Tip: there are VS Code tasks for common actions (Docker up, run API on 8081, restart API detached).

## Option A (recommended): install Docker Desktop
- Install Docker Desktop for Windows.
- Then from repo root run:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\tree"
docker compose -f .\api\docker-compose.yml up -d --build
```

This starts:
- Postgres/PostGIS on `localhost:5432` (db/user/pass all `genealogy`)
- API on `http://localhost:8081`

## Option B: use any Postgres+PostGIS (local install or managed)
You need:
- Postgres 15+ (16 recommended)
- PostGIS extension available

Set `DATABASE_URL` like:
`postgresql://genealogy:genealogy@HOST:5432/genealogy`

Note: the included VS Code tasks set `DATABASE_URL` for *your* machine. If you're using Docker (Option A), a common local value is:
`postgresql://genealogy:genealogy@localhost:5432/genealogy`

If you run Postgres locally with different credentials (for example `postgres:<password>`), override `DATABASE_URL` accordingly.

## Load an export into Postgres
This loads the JSONL export produced by the `.gramps`/`.gpkg` exporter.

Example using your latest export folder (usually under `reports/gramps_export_<timestamp>/`):

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\tree"
$env:DATABASE_URL = "postgresql://genealogy:genealogy@localhost:5432/genealogy"

.\export\load_export_to_postgres.ps1 `
  -ExportDir .\reports\gramps_export_20260117_194704 `
  -DatabaseUrl $env:DATABASE_URL `
  -Truncate
```

## Run the API locally (no docker)
If you have a Postgres instance reachable via `DATABASE_URL`:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\tree\api"
$env:DATABASE_URL = "postgresql://genealogy:genealogy@localhost:5432/genealogy"
..\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8081

Optional port override (PowerShell):
`$env:TREE_PORT=8090`
```
## First-time auth setup
Before you can use the viewer, you need to create an admin user and an instance:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\tree"
$env:DATABASE_URL = "postgresql://genealogy:genealogy@localhost:5432/genealogy"

# Create the admin user (also creates the _core schema if needed)
.\.venv\Scripts\python.exe -m api.admin create-admin --username admin --password Admin123

# Create an instance (each instance gets its own Postgres schema)
.\.venv\Scripts\python.exe -m api.admin create-instance --slug default --name "Family Tree"

# Optional: create a regular user assigned to an instance
.\.venv\Scripts\python.exe -m api.admin create-user --username alice --password Alice123 --instance default
```

### Roles
- **admin**: Can create instances, manage all users, switch between instances. Sees instance picker after login.
- **user**: Owns one instance. Can import data, toggle privacy, manage guests. Auto-redirects to their instance.
- **guest**: Read-only access to one instance. Cannot import, toggle privacy, or manage guests. Auto-redirects.

Guests can be created via the Options menu in the viewer (by users or admins).
## Endpoints to try
- `GET /health`
- `GET /people/{id}`
- `GET /people/search?q=Hofland`
- `GET /relationship/path?from_id=<id>&to_id=<id>&max_hops=12`

Graph endpoints (used by the demo viewer)
- `GET /graph/neighborhood?id=I0001&depth=2&max_nodes=1000&layout=family`
- Expand up (parents of a family hub):
  - `GET /graph/family/parents?family_id=<family_id_or_gramps_id>&child_id=<child_person_id>`
- Expand down (children of a family hub):
  - `GET /graph/family/children?family_id=<family_id_or_gramps_id>&include_spouses=true`

Import endpoints:
- `POST /import` — upload a `.gpkg` / `.gramps` file (max 200 MB) to trigger the import pipeline
- `GET /import/status` — poll import progress (`idle` / `running` / `done` / `failed`)

Auth endpoints:
- `POST /auth/login` — `{ username, password }` → sets `tree_session` + `tree_csrf` cookies
- `POST /auth/logout` — clears session cookie
- `GET /auth/me` — current user + instance info
- `POST /auth/switch-instance` — `{ slug }` → switches active instance (admin only)

User notes endpoints:
- `GET /user-notes` — list notes (optional `?gramps_id=` filter)
- `POST /user-notes` — create a note `{ gramps_id, body }`
- `PUT /user-notes/{id}` — update a note `{ body }`
- `DELETE /user-notes/{id}` — delete a note

Guest management endpoints:
- `POST /instances/{slug}/guests` — create a guest `{ username, password }`
- `GET /instances/{slug}/guests` — list guests
- `DELETE /instances/{slug}/guests/{user_id}` — remove a guest

Media endpoints:
- `GET /media?limit=100&offset=0&q=&mime=&sort=` — paginated media list
- `GET /media/{media_id}` — single media detail with references (persons, events, places)
- `GET /media/file/thumb/{filename}` — serve thumbnail PNG (transparent)
- `GET /media/file/original/{filename}` — serve original file
- `GET /people/{person_id}/media` — ordered media for a person (portrait + gallery)
- `PUT /people/{person_id}/portrait` — set/clear portrait override `{ media_id }`

Notes:
- Family nodes may include `parents_total` and `children_total` which the viewer uses to decide whether to show expand indicators.
- All graph and people endpoints accept an optional `privacy=off` query parameter to bypass server-side redaction.

## Demo UI (graph)

The demo UI is served from the API:
- **Primary (going forward):** `/demo/relationship` (relchart v3; Graphviz WASM + modular JS/CSS)  - **Login required**: navigate to `/demo/relationship` → redirects to `/login` if not authenticated.
  - After login, admins see the instance picker; users/guests auto-redirect to their instance.  - Click a person card or family hub to show both API id + Gramps id in the status bar and copy them to clipboard.
  - Clicking a family hub is selection-only (it does not expand or recenter).
  - **Cull toggle:** for very large graphs, enable *Cull* to hide off-screen SVG elements and keep pan/zoom responsive.
  - Map tab:
    - The map renders inside the same main viewport as the graph and cross-fades when switching tabs.
    - Leaflet is lazy-loaded from a CDN; base tiles are OpenStreetMap raster tiles.
    - If you’re offline or behind a strict firewall, the map may fail to load (the rest of the UI still works).
- Legacy/reference demos:
  - `/demo/graph` (interactive; older)
  - `/demo/viewer` (older viewer shell/prototype)

If you edit the static demo file, you usually only need a hard refresh (Ctrl+F5).

Graphviz-specific notes:
- The Graphviz (DOT) view is the most readable for genealogy.
- Multi-spouse people are rendered as a single person node with spouse–family–person blocks.
- Malformed edges are ignored (e.g., a `child` edge that points to a family node) to prevent orphan family hubs.
- The viewer supports map-like interaction: drag to pan, wheel to zoom around the cursor (including when zoomed way out).
- The relationship chart keeps pan/zoom stable during selection; use Fit/controls to change view.

Privacy:
- Privacy is enforced server-side; private people are redacted before JSON reaches the browser.
- The Options menu includes a **Privacy filter** toggle: unchecking it adds `?privacy=off` to all API calls, revealing real names/dates.
- An amber "Privacy off" badge appears in the top bar when the filter is disabled.
- The toggle is never persisted — refreshing the page resets privacy to ON.
- See `docs/architecture/PRIVACY.md` for the current policy/thresholds.

Import:
- The Options menu includes an **Import** section for uploading `.gpkg` / `.gramps` files.
- The import runs server-side in a background thread; the frontend shows a blocking overlay and polls for completion.
- On success, the graph and all sidebar data auto-reload with the new data.
- Import is only available to users and admins (hidden for guests).
- The import pipeline extracts media files from the archive and generates 200×200 PNG thumbnails (preserving transparency for coat-of-arms / heraldry images).

Media:
- Person cards in the graph show portrait thumbnails (rounded clip mask, no border) on the left side of the card.
- Face photos use `slice` (crop to fill); tall images like coat of arms use `meet` (fit fully, no cropping).
- The topbar "Media" button opens a full-screen media browser overlay with search, sort, metadata sidebar, and thumbnail grid.
- The person detail panel Media tab shows all media linked to the selected person with a portrait picker.
- Clicking a thumbnail in the media browser selects it; clicking the preview opens the lightbox.

Auth:
- Sessions use JWT in an `HttpOnly` cookie (`tree_session`, 24h expiry with sliding refresh).
- CSRF protection: a readable `tree_csrf` cookie is sent with every response; mutating requests must include `X-CSRF-Token` header.
- Rate limiting: 5 failed login attempts per IP per 5-minute window → HTTP 429.
- Password requirements: ≥8 characters, must contain uppercase + lowercase + digit.
