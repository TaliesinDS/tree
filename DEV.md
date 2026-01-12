# Genealogy dev runbook

You currently **do not** have `docker` or `psql` on PATH (that’s why `docker compose up` failed).

The code is ready; you just need a Postgres+PostGIS instance to point it at.

## Option A (recommended): install Docker Desktop
- Install Docker Desktop for Windows.
- Then from repo root run:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\TaliesinDS.github.io"
docker compose -f .\genealogy\api\docker-compose.yml up -d --build
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
Set-Location "C:\Users\akortekaas\Documents\GitHub\TaliesinDS.github.io"
$env:DATABASE_URL = "postgresql://genealogy:genealogy@localhost:5432/genealogy"

.\genealogy\export\load_export_to_postgres.ps1 `
  -ExportDir .\genealogy\exports\run_20260111_160635 `
  -DatabaseUrl $env:DATABASE_URL `
  -Truncate
```

## Run the API locally (no docker)
If you have a Postgres instance reachable via `DATABASE_URL`:

```powershell
Set-Location "C:\Users\akortekaas\Documents\GitHub\TaliesinDS.github.io\genealogy\api"
$env:DATABASE_URL = "postgresql://genealogy:genealogy@localhost:5432/genealogy"
..\..\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8080
```

## Endpoints to try
- `GET /health`
- `GET /people/{id}`
- `GET /people/search?q=Hofland`
- `GET /relationship/path?from_id=<id>&to_id=<id>&max_hops=12`

Privacy:
- The API will always return `display_name: "Private"` for `is_private` or `is_living` rows.
