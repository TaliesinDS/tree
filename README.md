# Genealogy app (backend-first)

Quick resume doc (for future you / new chats): see `HANDOFF.md`.

This folder is an **in-repo design + scaffold** for a future genealogy web app.

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
- `api/`: FastAPI stub (health + placeholder endpoints)
- `sql/schema.sql`: starter schema sketch

Export tooling
- `export/inspect_gramps_sqlite.py`: schema discovery for your Gramps SQLite
- `export/export_gramps_sqlite.py`: (next) export + redaction pipeline
