# Genealogy Project Handoff

> **Resuming work?** Attach this file to your AI chat and say:
> *"We're continuing the Tree genealogy project. Please read HANDOFF.md and continue."*

---

## What This Is

**Tree** is a **view-only** genealogy browser:
- Source of truth: **Gramps Desktop** (export via `.gramps`/`.gpkg`)
- Backend: **FastAPI + PostgreSQL/PostGIS** (read-only API, server-side privacy)
- Frontend: **Browser-based graph viewer** using Graphviz WASM

**Not an editor** — Gramps Desktop remains the authoring tool.

---

## Quick Start (Local Dev)

```powershell
# 1. Start Postgres (Docker or external)
# 2. Set DATABASE_URL
$env:DATABASE_URL = "postgresql://postgres:polini@localhost:5432/genealogy"

# 3. Start API (use VS Code task or manually)
# Task: "genealogy: restart api (detached 8080)"

# 4. Open viewer
# http://127.0.0.1:8080/demo/relationship
```

Full setup: [docs/guides/DEV.md](docs/guides/DEV.md)

---

## Architecture Summary

| Component | Location | Notes |
|-----------|----------|-------|
| **API** | `api/main.py` | FastAPI endpoints, privacy filtering |
| **Frontend (v3)** | `api/static/relchart/` | Graphviz WASM relationship chart |
| **Export pipeline** | `export/` | Gramps XML → JSONL → Postgres |
| **Schema** | `sql/schema.sql` | Postgres + PostGIS tables |

**Active frontend:** `/demo/relationship` (relchart v3)  
**Legacy viewers:** `/demo/viewer`, `/demo/graph` (do not modify)

---

## Key Documentation

| Need to... | Read this |
|------------|-----------|
| Understand the architecture | [docs/architecture/RELCHART.md](docs/architecture/RELCHART.md) |
| See planned features | [docs/specs/FEATURES.md](docs/specs/FEATURES.md) |
| Understand privacy rules | [docs/architecture/PRIVACY.md](docs/architecture/PRIVACY.md) |
| Set up local dev | [docs/guides/DEV.md](docs/guides/DEV.md) |
| See all documentation | [docs/README.md](docs/README.md) |

---

## Current State (Jan 2026)

**Working:**
- ✅ Export pipeline (Gramps → JSONL → Postgres)
- ✅ Graph viewer with expand-in-place (parents/children)
- ✅ People/Families/Events sidebars
- ✅ Person detail panel
- ✅ Map tab MVP (Leaflet + OSM tiles)
- ✅ Privacy enforcement (server-side)

**In Progress / Planned:**
- 🔲 Relationship path highlighting (API exists, UI pending)
- 🔲 Ancestor line highlighting (lineage.js utilities ready)
- 🔲 Note search (full-text index exists)
- 🔲 Map markers/routes
- 🔲 Offline map support

---

## Key Files (Quick Reference)

### Frontend (relchart v3)
```
api/static/relchart/
├── index.html          # UI shell
├── styles.css          # Styling
└── js/
    ├── app.js          # Main app logic
    ├── api.js          # Fetch wrappers
    └── chart/
        ├── dot.js      # DOT generation (payload → Graphviz)
        ├── render.js   # SVG post-processing
        ├── lineage.js  # Ancestor/descendant tracing utilities
        ├── payload.js  # Payload merge
        ├── panzoom.js  # Pan/zoom
        └── graphviz.js # WASM loader
```

### Backend
```
api/main.py        # Endpoints + privacy
api/db.py          # DB connection
sql/schema.sql     # Tables + indexes
```

---

## Next Tasks (Suggested)

1. **Relationship path UI** — highlight path between two people
2. **Ancestor line highlighting** — use `lineage.js` utilities
3. **Note search** — endpoint using `note.body_tsv`
4. **Map improvements** — markers, routes, filtering

---

## Repository Map

```
tree/
├── README.md              # Project overview
├── HANDOFF.md             # This file (resume pointer)
├── docs/                  # All documentation
│   ├── README.md          # Doc index
│   ├── architecture/      # How it works
│   ├── specs/             # What to build
│   ├── guides/            # How to do things
│   ├── design/            # UI/art planning
│   └── debug/             # Bug investigations
├── api/                   # FastAPI + static frontend
├── export/                # Gramps export pipeline
├── sql/                   # Database schema
└── reports/               # Runtime logs + exports
```

---

*For detailed architecture, decisions, and rationale, see the docs/ folder.*
