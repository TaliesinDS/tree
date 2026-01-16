# Genealogy app (backend-first)

Quick resume doc (for future you / new chats): see HANDOFF.md.

This repo is a **backend-first genealogy web app scaffold** with a working local API + demo UI.

Goals (what you asked for)
- Pick any **two people** → show the **ancestry/relationship path** between them.
- **Search inside notes**, and sort/filter by event description/content.
- Use **place/location** data and show it on a **map**.
- Enforce privacy: public site, but **living people auto-private**.

Why this isn’t GitHub Pages-only
- GitHub Pages is static hosting. The feature list implies **querying** (graph traversal, full-text search, map queries), which requires a **backend + database**.

Suggested architecture (pragmatic)
- **API**: FastAPI (Python) on **Cloud Run**.
- **DB**: Postgres + PostGIS (Cloud SQL) for:
  - recursive queries / graph-ish traversal for relationship paths
  - full-text search (tsvector) for notes/events
  - geospatial indexing/queries for places
- **Frontend**: keep your Jekyll site as-is; add a separate subdomain like `tree.arthurkortekaas.nl` for the app UI.

Next steps
1) Decide where the **source-of-truth** lives:
   - keep Gramps as authoring tool and **export/sync** into Postgres (recommended)
   - or move entirely to a web-native DB (bigger change)
2) Agree on the privacy rule:
   - “living = no death date AND birth within N years” (common), plus manual override
3) Build import pipeline from Gramps (SQLite) → Postgres

Files
- `api/`: FastAPI app + graph endpoints + demo UI
- `sql/schema.sql`: starter schema sketch

Demo UI
- **Primary UI (going forward):** `/demo/relationship` — **relchart v3** (Graphviz WASM + modular JS/CSS).
   - This is the Gramps-Web-like relationship chart: couples + family hubs + children, with expand-in-place.
   - Clicking a person card or family hub updates the status bar with both API id + Gramps id and copies them to clipboard.
   - Clicking a family hub is selection-only (it does not expand or recenter).
- Legacy/reference demos:
   - `/demo/graph` — older neighborhood graph demo.
   - `/demo/viewer` — older viewer shell/prototype.

Relationship chart architecture notes:
- `ARCHITECTURE_RELCHART.md`

Interactive “carve-a-path” expansion
- The viewer supports incremental expand-in-place actions:
   - **Expand up**: `GET /graph/family/parents?family_id=<family>&child_id=<child>`
   - **Expand down**: `GET /graph/family/children?family_id=<family>&include_spouses=true`
- Family nodes may include metadata used by indicator logic:
   - `parents_total` (0/1/2)
   - `children_total` (0+)
   - `has_more_children` (legacy/hint; used only when totals aren’t present)

Export tooling
- `export/inspect_gramps_sqlite.py`: schema discovery for your Gramps SQLite
- `export/export_gramps_sqlite.py`: (next) export + redaction pipeline
