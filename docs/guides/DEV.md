# Genealogy dev runbook

This repo is designed to run locally on Windows (PowerShell), backed by Postgres + PostGIS.

Tip: there are VS Code tasks for common actions (Docker up, run API on 8080, restart API detached).

## Option A (recommended): install Docker Desktop
- Install Docker Desktop for Windows.
- Then from repo root run:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\tree"
docker compose -f .\api\docker-compose.yml up -d --build
```

This starts:
- Postgres/PostGIS on `localhost:5432` (db/user/pass all `genealogy`)
- API on `http://localhost:8080`

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
..\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8080
```

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

Notes:
- Family nodes may include `parents_total` and `children_total` which the viewer uses to decide whether to show expand indicators.

## Demo UI (graph)

The demo UI is served from the API:
- **Primary (going forward):** `/demo/relationship` (relchart v3; Graphviz WASM + modular JS/CSS)
  - Click a person card or family hub to show both API id + Gramps id in the status bar and copy them to clipboard.
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
- See `docs/architecture/PRIVACY.md` for the current policy/thresholds.
