# Deployment options (personal sharing)

This guide documents **practical hosting options** for Tree when the goal is:
- you host **one** instance (your personal tree)
- you share it with friends/family
- you do **not** support “users uploading their own trees” (not a multi-tenant SaaS)

Tree has two runtime parts:
1) **UI** (static HTML/CSS/JS)
2) **API** (FastAPI) + **database** (Postgres)

**Important**: Tree now requires authentication. Before first use, run the admin CLI to create an admin user and at least one instance (see DEV.md for setup).

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
- `JWT_SECRET` (defaults to a random value per process — set explicitly for multi-process or persistent sessions)

Recommended:
- Keep secrets out of git
- Prefer platform-managed secrets (environment variables)

## Authentication model

Tree uses JWT cookie-based authentication:
- `tree_session`: HttpOnly cookie containing the JWT (24h expiry, sliding refresh).
- `tree_csrf`: Readable cookie for CSRF double-submit pattern.
- All mutating requests (`POST`, `PUT`, `DELETE`) require an `X-CSRF-Token` header matching the `tree_csrf` cookie.
- Rate limiting: 5 failed login attempts per IP per 5-minute window (in-memory; resets on restart).

### Cookie settings for production
- Set `Secure` flag if serving over HTTPS (currently `SameSite=Lax`, no `Secure` flag for local dev).
- If separating UI and API on different origins, cookies won't work without `SameSite=None; Secure`.
- **Recommendation**: Keep UI and API on the same origin (Option A) to avoid cookie/CORS complexity.

### Multi-instance
- Each instance gets its own Postgres schema (`inst_<slug>`).
- Admin users can switch between instances; regular users and guests are bound to one instance.
- Instance creation is done via CLI (`api/admin.py create-instance`).

## Privacy model (server-side)

Privacy enforcement must remain server-side:
- the API redacts private/living records before returning JSON
- the UI must treat all data it receives as public
- all privacy-sensitive endpoints accept an optional `privacy=off` query parameter to bypass redaction (used by the client-side privacy toggle in the Options menu; only available to users and admins, not guests)
- the privacy toggle is never persisted; refreshing the page resets it to ON

Policy details: see `docs/architecture/PRIVACY.md`.
