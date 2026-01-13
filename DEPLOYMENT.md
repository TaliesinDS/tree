# Deployment sketch (Cloud Run + Cloud SQL)

This is a deployment sketch for running the genealogy backend as a **real service**, while keeping your main website on **GitHub Pages/Jekyll**.

## Recommended shape
- Main site: `www.arthurkortekaas.nl` → GitHub Pages (unchanged)
- Genealogy app:
  - UI: `tree.arthurkortekaas.nl` (static SPA hosting, or even served by the API)
  - API: `api.tree.arthurkortekaas.nl` (Cloud Run)
  - DB: Cloud SQL (Postgres + PostGIS)

This avoids trying to “merge” two hosting providers on the same path.

## Components
- Cloud Run service: container built from `api/Dockerfile`
- Cloud SQL Postgres instance (enable PostGIS)
- Optional later:
  - Meilisearch/Typesense/OpenSearch if Postgres full-text becomes limiting

## Secrets
- No secrets in the repo.
- Use Secret Manager for DB password, any API keys, etc.

## Privacy model (server-side)
- The API is responsible for hiding living people.
- The frontend never receives private data.

## Next implementation steps
1) Create Cloud SQL + run `sql/schema.sql`.
2) Wire DB access in the API.
3) Build a **Gramps → Postgres** importer (one-way sync).
4) Add a minimal frontend UI (pick person A + B → show path; search notes; map view).
