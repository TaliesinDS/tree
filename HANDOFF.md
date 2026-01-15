# Genealogy project handoff (read this to resume)

If you’re starting a new chat: **attach this file** (or paste it) and say:

> We’re continuing the TaliesinDS.github.io genealogy project. Please read HANDOFF.md and continue from the “Current state / next tasks” section.

This repo is a **backend-first genealogy app** scaffold with a working local demo UI.

## What we’re building (goals)

Primary features:
- Pick any **two people** → show the **relationship path** between them (graph traversal).
- **Search inside notes** and sort/filter by event description/content.
- Use **places** and show them on a **map**.
- Host publicly while enforcing **privacy** (living people auto-redacted).

Why this isn’t GitHub Pages-only:
- The above requires querying (graph traversal, full-text search, geospatial queries), so we use a **backend + database**.

## High-level architecture

Source of truth & data flow:
1) **Gramps** remains the authoring tool.
2) Export from Gramps as **Gramps XML/package** (`.gramps`/`.gpkg`).
3) Export pipeline converts that into **normalized JSONL** files (privacy-aware).
4) Loader ingests JSONL into **Postgres + PostGIS**.
5) FastAPI serves **read-only** endpoints (privacy enforced server-side).
6) A small in-browser demo UI visualizes the graph and helps debug layout.

Hosting sketch (intended):
- Main site stays on GitHub Pages.
- API runs separately (Cloud Run), backed by Cloud SQL (Postgres + PostGIS).

## Key decisions (and why)

### Use Gramps XML/package export, not direct Gramps SQLite
- Decision: treat Gramps SQLite as “work DB”, but export via `.gramps` / `.gpkg`.
- Why: Gramps SQLite stores key data in internal serialized blobs (`blob_data`), which is painful/fragile to decode. Gramps XML is the stable-ish interchange format.

### Use Postgres + PostGIS
- Decision: central website DB is Postgres with PostGIS enabled.
- Why:
  - graph-ish queries are feasible (and easy to index) with relational tables
  - built-in full-text search via `tsvector`
  - map queries need geospatial indexing

### Privacy is enforced server-side
- Decision: the API redacts living/private rows before returning JSON.
- Why: anything sent to a browser is effectively public.

Privacy rule (conservative / privacy-first):
- If death date exists → not living.
- If birth date is unknown → treat as living.
- Else if birth is within N years (default 110) → living.

### Graph model: “family hubs” as the default
- Decision: the API supports two graph shapes:
  - `layout=family`: **family hub nodes** (family + person nodes) with parent/child edges.
  - `layout=direct`: person-only graph with parent and partner edges.
- Why: family hubs are more readable for genealogy (it matches how Gramps/Graphviz tends to render lineage). Direct edges can be useful for generic graph layouts but tangle more easily.

### Graph rendering: use Graphviz DOT for best layout
- Decision: the demo UI includes a Graphviz DOT renderer (via wasm graphviz) because it produces the cleanest generational layout.
- Why: force-directed layouts (Cytoscape cose) look cool but are not reliable for genealogy readability.

### Multi-spouse handling (Graphviz)
Problem:
- A single person can have multiple spouses/families; naïve ordering can duplicate-looking nodes or produce floating family hubs.

Current approach:
- Keep **one person node per person id**.
- For multi-spouse people, create a dedicated **marriage row** (rank-same block) with spouse/family hubs ordered by **child count** (so “main” family tends to be prioritized).
- Do not pull spouses into a birth-family sibling row if that person is a parent/spouse elsewhere (prevents “spouse next to siblings” artifacts).
- Ignore malformed edges when building the DOT adjacency maps (e.g., skip any `child` edge whose target is not a person) to prevent family→family links and orphan hubs.

## Repository map (where things live)

Top-level docs:
- ./README.md — high-level goals and architecture overview
- ./PRIVACY.md — privacy model and redaction behavior
- ./DEV.md — local dev runbook (Docker vs external Postgres)
- ./DEPLOYMENT.md — Cloud Run / Cloud SQL sketch
- ./NOTES_ON_FEATURES.md — feature → capability mapping

API:
- api/main.py — FastAPI endpoints; privacy filtering; neighborhood/path logic
- api/db.py — DB connection helper (simple per-request connection)
- api/static/graph_demo.html — interactive graph demo (Cytoscape + Graphviz)
- api/static/viewer_ported.html — newer Gramps-Web-like viewer shell (Graphviz + sidebar tabs)
- api/restart_api_8080.ps1 — start/restart uvicorn detached, logs to reports/

Export pipeline:
- export/README.md — why Gramps XML export; how to run exporter/loader
- export/export_gramps_package.py — parse `.gramps`/`.gpkg` and output JSONL
- export/load_export_to_postgres.py — create schema + load JSONL into Postgres

Database schema:
- sql/schema.sql — tables for person/family/event/place/note + indexes + note tsvector trigger

## Current state / what works

- Export pipeline can generate JSONL from Gramps packages.
- Loader ingests JSONL into Postgres + PostGIS.
- API provides:
  - person lookup
  - relationship path search
  - neighborhood graph endpoint (family hubs or direct)
  - incremental expand-in-place endpoints used by the viewer:
    - `GET /graph/family/parents?family_id=<family>&child_id=<child>`
    - `GET /graph/family/children?family_id=<family>&include_spouses=true`
- Demo UI can render:
  - Cytoscape view (dagre family layout / cose direct layout)
  - Graphviz view (DOT → SVG)

## Recent work (Jan 2026)

Graphviz layout stability:
- Multi-spouse layout now supports spouse1–common–spouse2 patterns without duplicating people.
- Added defensive filtering so malformed edges (e.g., family→family “child” edges) don’t create orphan family hubs.

Viewer UX (Graphviz /demo/viewer):
- Family hubs (⚭) are post-processed in SVG for a Gramps-Web-like look.
- Redundant spouse→hub connector stubs are hidden when the hub touches spouse cards.
- Edge endpoints that attach to the hub are snapped to the hub ellipse boundary to avoid tiny overshoots in very large families.
- Pan/zoom is viewBox-based and tuned so drag feels 1:1 at any zoom.
- Status text includes the Gramps ID when present in the payload.

Incremental expand stability (expand up/down):
- Expand endpoints now return family node totals (`parents_total`, `children_total`) so indicators can reflect “known missing relatives” instead of guessing.
- Up/down indicator computations only count *renderable* edges (endpoints exist as nodes), avoiding “indicators disappear / lines vanish then reappear” glitches.
- Fixed a server-side crash in `GET /graph/family/parents` when a family had no parent ids (the response is now a valid empty expansion instead of a 500).

## How to run locally (quick)

1) Ensure you have a Postgres+PostGIS instance.
2) Set `DATABASE_URL`.
3) Run the API.

See DEV.md for the exact PowerShell commands and Docker option.

## Current sharp edges / known constraints

- DB connection is per-request (no pooling) — fine for dev.
- Full text search indexing exists for notes, but search endpoints/UI are still minimal.
- Graphviz rendering is currently demo-UI-side (browser wasm), not server-side.

## Next tasks (suggested order)

1) Add a minimal real UI (beyond the demo) for:
   - person search → select two people → show relationship path
2) Implement note search endpoint(s) using `note.body_tsv`.
3) Implement place endpoints and map view.
4) Decide on deployment details (Cloud Run + Cloud SQL) and secret handling.

---

If you need more context quickly, open the files in “Repository map” and skim the top sections; they were written explicitly to preserve decisions and rationale.
