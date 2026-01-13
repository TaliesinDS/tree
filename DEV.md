# Genealogy dev runbook

This repo is designed to run locally on Windows (PowerShell), backed by Postgres + PostGIS.

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

## Load an export into Postgres
This loads the JSONL export produced by the `.gpkg` exporter.

Example using your latest good export folder:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\tree"
$env:DATABASE_URL = "postgresql://genealogy:genealogy@localhost:5432/genealogy"

.\export\load_export_to_postgres.ps1 `
  -ExportDir .\exports\run_20260111_160635 `
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

## Demo UI (graph)

The demo UI is served from the API:
- `/demo/graph` (interactive)

If you edit the static demo file, you usually only need a hard refresh (Ctrl+F5).

Graphviz-specific notes:
- The Graphviz (DOT) view is the most readable for genealogy.
- Multi-spouse people are rendered as a single person node with spouse–family–person blocks.
- Malformed edges are ignored (e.g., a `child` edge that points to a family node) to prevent orphan family hubs.

Privacy:
- The API will always return `display_name: "Private"` for `is_private` or `is_living` rows.
