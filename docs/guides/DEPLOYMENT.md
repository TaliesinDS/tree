# Deployment options (personal sharing)

This guide documents **practical hosting options** for Tree when the goal is:
- you host **one** instance (your personal tree)
- you share it with friends/family
- you do **not** support “users uploading their own trees” (not a multi-tenant SaaS)

Tree has two runtime parts:
1) **UI** (static HTML/CSS/JS)
2) **API** (FastAPI) + **database** (Postgres)

## Option A (recommended): host UI and API together

This is the simplest operationally because the UI can call the API with **same-origin** requests.

Shape:
- App (UI + API): one host (container) serving:
  - UI at `/demo/relationship`
  - API at `/graph/...`, `/people/...`, etc.
- DB: managed Postgres (can be hosted anywhere)

Pros:
- No CORS complexity
- One URL to share
- Matches current dev behavior (static files served by the API)

Cons:
- Your “static” UI is not on GitHub Pages (it’s still static, just served by the API host)

Good fits:
- Cloud Run (container)
- Fly.io / Render / Railway (container)

DB recommendation for low traffic:
- A small managed Postgres (e.g. Supabase free tier often works fine for small personal datasets)

## Option B: GitHub Pages for UI + separate API host

This is great if you already have a Pages site and want the UI hosted there.

Shape:
- UI: GitHub Pages (static)
- API: hosted elsewhere (container)
- DB: managed Postgres

Pros:
- UI hosting is free and extremely reliable
- Easy to keep UI on the same domain as your existing Pages site

Cons:
- You must handle **CORS** (browser security)
- You need a way for the UI to know the API base URL

Implementation notes:
- Today the relchart frontend calls endpoints using relative URLs (same-origin). If you host the UI separately,
  you’ll typically add an `API_BASE_URL` config (or similar) and use it in fetch wrappers.

## CORS checklist (when UI and API are on different origins)

If your UI is on `https://example.github.io` and your API is on `https://api.example.com`:
- Allow CORS origin: `https://example.github.io` (and your custom domain if you use one)
- Allow credentials only if you truly need cookies (you likely don’t)
- Allow methods: `GET` (Tree is read-only)

## Database options

Tree benefits from Postgres for:
- relationship/path queries
- full-text search
- place queries (optionally PostGIS)

You can choose:
- Local Postgres (Docker / local install) for development
- Hosted Postgres for sharing publicly

Cost note:
- Your current dataset size is small (thousands of people/events). Database size is typically in the **tens of MB**,
  so free-tier Postgres limits are usually not the blocker; “always-on” pricing is.

## Secrets and configuration

Minimum required:
- `DATABASE_URL`

Recommended:
- Keep secrets out of git
- Prefer platform-managed secrets (environment variables)

## Privacy model (server-side)

Privacy enforcement must remain server-side:
- the API redacts private/living records before returning JSON
- the UI must treat all data it receives as public

Policy details: see `docs/architecture/PRIVACY.md`.
