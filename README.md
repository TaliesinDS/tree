# Tree (Gramps genealogy viewer)

**Resuming work?** → See [HANDOFF.md](HANDOFF.md)  
**All documentation** → See [docs/README.md](docs/README.md)

This repo is a **view-only genealogy browser** that visualizes data exported from Gramps Desktop.

## Goals

- Pick any **two people** → show the **ancestry/relationship path** between them
- **Search inside notes**, and sort/filter by event description/content
- Use **place/location** data and show it on a **map**
- Enforce privacy: public site, but **living/private people are redacted server-side**

## Architecture

| Component | Location | Notes |
|-----------|----------|-------|
| **API** | `api/main.py` + `api/routes/` | FastAPI app wiring + route handlers (read-only + privacy filtering) |
| **Auth** | `api/auth.py` + `api/middleware.py` | JWT cookie auth, CSRF, role-based access (admin/user/guest) |
| **Frontend** | `api/static/relchart/` | Graphviz WASM relationship chart (v3) |
| **Export pipeline** | `export/` | Gramps XML → JSONL → Postgres |
| **Schema** | `sql/schema.sql` + `sql/schema_core.sql` | Genealogy tables (per-instance) + auth tables |
| **Docs** | `docs/` | All documentation |

**Why not GitHub Pages-only?** The feature list implies querying (graph traversal, full-text search, map queries), which requires a backend + database.

## Quick Start

```powershell
# 1. Postgres running (Docker or external)
# 2. Set DATABASE_URL
$env:DATABASE_URL = "postgresql://postgres:polini@localhost:5432/genealogy"

# 3. First-time auth setup
.\.venv\Scripts\python.exe -m api.admin create-admin --username admin --password Admin123
.\.venv\Scripts\python.exe -m api.admin create-instance --slug default --name "Family Tree"

# 4. Start API
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8081

# 5. Open http://127.0.0.1:8081/demo/relationship
#    Log in with admin / Admin123, pick the "Family Tree" instance

# Port override (optional)
# - PowerShell: $env:TREE_PORT=8090
# - Then run start_tree.ps1 or the VS Code tasks
```

Full setup: [docs/guides/DEV.md](docs/guides/DEV.md)

## Demo UI

**Primary UI:** `/demo/relationship` — relchart v3 (Graphviz WASM)

Requires login (admin/user/guest). Admins see an instance picker; users/guests auto-redirect.

Features:
- Gramps-Web-like relationship chart: couples + family hubs + children
- Expand-in-place (parents/children)
- People/Families/Events sidebars
- Places list + Map view (Leaflet + OSM)
- **Cull toggle**: hide off-screen SVG elements for large graphs
- **Privacy toggle**: Options menu → uncheck "Privacy filter" to reveal private people (amber badge; never persisted)
- **In-browser import**: Options menu → upload `.gpkg` / `.gramps` file to reload the database
- **User notes**: per-person notes in detail panel (survive re-imports)
- **Guest management**: create/delete guest accounts via Options menu
- **Role-based UI**: import/privacy hidden for guests

**Legacy demos:** `/demo/graph`, `/demo/viewer` (do not modify)

## Documentation

| Topic | Document |
|-------|----------|
| Architecture | [docs/architecture/RELCHART.md](docs/architecture/RELCHART.md) |
| Auth & multi-instance | [docs/architecture/plan-multiUser.md](docs/architecture/plan-multiUser.md) |
| Privacy model | [docs/architecture/PRIVACY.md](docs/architecture/PRIVACY.md) |
| Features/roadmap | [docs/specs/FEATURES.md](docs/specs/FEATURES.md) |
| Local dev setup | [docs/guides/DEV.md](docs/guides/DEV.md) |
| All docs | [docs/README.md](docs/README.md) |

## Export Pipeline

1. Export from Gramps Desktop as `.gramps` / `.gpkg`
2. Run `export/export_gramps_package.py` → JSONL files
3. Run `export/load_export_to_postgres.py` → Postgres tables

Alternatively, use the **in-browser import**: upload `.gpkg` / `.gramps` directly via the Options menu in the viewer.

See [export/README.md](export/README.md) for details.
