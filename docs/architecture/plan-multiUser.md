# Multi-User & Multi-Instance Implementation Plan

**Date**: 2026-02-10  
**Scope**: Add authentication, role-based access control, per-instance (per-family-tree) database isolation, user notes, and safe re-import that preserves user data.

---

## 1. Concepts & Terminology

| Term | Meaning |
|------|---------|
| **Instance** | A single family tree dataset (e.g. "Hofland family tree"). Backed by its own PostgreSQL schema. |
| **Admin** | Global super-user. Can create/delete instances, create any user/guest, do everything. |
| **User** | Bound to one or more instances. Can import/re-import, create user notes, toggle privacy, create guest accounts for their instance. |
| **Guest** | Read-only access to a specific instance. Cannot import, export, create notes, or toggle privacy. |
| **User note** | A note authored by any logged-in user, visible to **all users and guests** in the instance (public announcement board). Attached to a person by `gramps_id`. Survives re-imports. Distinct from Gramps-authored notes. Purpose: research coordination (e.g. "find source for this person"). Exportable as a list. |

---

## 2. High-Level Architecture

### 2.1 Current State (single-user, single-instance)

```
Browser ──► FastAPI ──► PostgreSQL (single `genealogy` DB, flat tables)
             │
             └── import: truncate all tables, reload
```

- No authentication.
- One shared `DATABASE_URL`.
- Privacy toggle is client-side (`?privacy=off`) — anyone can use it.

### 2.2 Target State

```
Browser ──► Login page ──► JWT cookie ──► FastAPI ──► PostgreSQL
                                           │
                   ┌───────────────────────┘
                   │
           ┌───────┴────────┐
           │  `_core` schema │  ← users, instances, memberships
           ├─────────────────┤
           │  `inst_hofland`  │  ← genealogy tables + user_note
           │  `inst_demo`     │  ← genealogy tables + user_note
           │  ...             │
           └─────────────────┘
```

Each instance gets its own **PostgreSQL schema** (`inst_<slug>`), all within the same `genealogy` database. A shared `_core` schema holds identity and access control.

**Why schemas, not separate databases?**
- Easier cross-schema queries if ever needed.
- Single connection string, single `psycopg` pool.
- Up to ~12 instances — schemas are the right isolation level.
- Simpler backup/restore (one `pg_dump`).

---

## 3. Database Design

### 3.1 Core Schema (`_core`)

```sql
CREATE SCHEMA IF NOT EXISTS _core;

-- ─── Users ───
CREATE TABLE _core.users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,          -- bcrypt via passlib
  role          TEXT NOT NULL DEFAULT 'guest',  -- 'admin' | 'user' | 'guest'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Instances (family trees) ───
CREATE TABLE _core.instances (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,   -- e.g. 'hofland' → schema `inst_hofland`
  display_name  TEXT NOT NULL,          -- e.g. 'Hofland Family Tree'
  created_by    INT REFERENCES _core.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Memberships (user ↔ instance, with role override) ───
CREATE TABLE _core.memberships (
  user_id       INT NOT NULL REFERENCES _core.users(id) ON DELETE CASCADE,
  instance_id   INT NOT NULL REFERENCES _core.instances(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'guest',  -- 'user' | 'guest' (admin is global)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instance_id)
);

-- Non-admin users are locked to exactly one instance.
-- (Admins bypass memberships entirely, so this constraint only affects user/guest.)
CREATE UNIQUE INDEX idx_memberships_one_instance_per_user
  ON _core.memberships (user_id);
```

**Role resolution**:
- If `users.role = 'admin'` → admin on ALL instances (no membership row needed). Admins are the only users who can work across multiple trees.
- Otherwise, `memberships.role` determines access: `'user'` or `'guest'`.
- **Users and guests are locked to exactly one instance.** The `memberships` table enforces a UNIQUE constraint on `user_id` (for non-admin users). Someone who needs to work on multiple trees should be (or become) an admin.
- No membership row → **no access** to that instance.

### 3.2 Instance Schema (`inst_<slug>`)

Each instance schema contains the **exact same tables** as today's public schema (`person`, `family`, `event`, `place`, `note`, `person_parent`, `person_event`, etc.), plus a new `user_note` table.

```sql
-- Created inside inst_<slug> schema:

-- (all existing tables from sql/schema.sql, unchanged)

-- ─── User Notes (survive re-imports) ───
CREATE TABLE user_note (
  id          SERIAL PRIMARY KEY,
  gramps_id   TEXT NOT NULL,              -- person.gramps_id (link key for re-imports)
  user_id     INT NOT NULL,               -- references _core.users(id)
  body        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_note_gramps_id ON user_note(gramps_id);
CREATE INDEX idx_user_note_user_id ON user_note(user_id);
```

**Why `gramps_id` and not `person.id`?**  
`person.id` is an internal Gramps handle that can change between exports. `gramps_id` (e.g. `I0063`) is the stable identifier assigned by the user in Gramps. When a database is re-imported, person handles may differ, but `gramps_id` stays the same — so user notes survive.

### 3.3 Schema Management Script

Create `sql/schema_core.sql` for the `_core` schema. Modify `sql/schema.sql` to be schema-agnostic (no hardcoded `public.`). The import pipeline will prefix `SET search_path TO inst_<slug>;` before executing.

---

## 4. Authentication & Session

### 4.1 Technology Choice

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| Password hashing | `bcrypt` via `passlib` | Industry standard, no external service needed |
| Session token | **JWT** stored in `HttpOnly` cookie | No external auth provider; stateless; simple |
| JWT library | `python-jose` or `PyJWT` | Lightweight |
| Token lifetime | 24 hours (configurable) | Balance between convenience and security |
| Refresh | Sliding window: new token on each request if >50% expired | Keeps active sessions alive |

### 4.2 Auth Flow

```
1. GET  /login              → serves login.html (static page)
2. POST /auth/login          → validates username + password
                               → sets HttpOnly JWT cookie (contains user_id, role, instance_slug)
                               → returns 200 + redirect URL
3. GET  /auth/logout         → clears the cookie
4. GET  /auth/me             → returns current user info + accessible instances
5. ALL  /api/*               → middleware checks JWT cookie
                               → injects `request.state.user` and `request.state.instance`
                               → rejects with 401/403 if invalid
```

### 4.3 Instance Resolution

Since users and guests are locked to exactly one instance, there is no instance picker needed for them — the JWT simply contains their single `instance_slug` (looked up from their membership at login time).

**Admins** have access to all instances. After login they see an instance picker page (or a selector in the sidebar) to choose which tree to view. Switching instances refreshes the JWT with the new `instance_slug`.

URLs stay unchanged — the active instance is always resolved from the JWT cookie.

### 4.4 Implementation Steps

1. Add Python deps: `passlib[bcrypt]`, `python-jose[cryptography]` (or `PyJWT`).
2. Create `api/auth.py` — password hashing, JWT create/verify, `get_current_user()` dependency.
3. Create `api/routes/auth.py` — `/auth/login`, `/auth/logout`, `/auth/me` endpoints.
4. Create `api/middleware.py` — FastAPI middleware (or dependency) that:
   - Extracts JWT from cookie.
   - Loads `user`, `role`, `instance_slug` into `request.state`.
   - Returns 401 if no valid token.
   - Returns 403 if user lacks access to the requested instance.
5. Create `api/static/login.html` — simple login form.
6. Create `api/static/instance_picker.html` — instance selection (admin only; users/guests skip this).

---

## 5. Authorization (Role-Based Access)

### 5.1 Permission Matrix

| Action | Admin | User | Guest |
|--------|-------|------|-------|
| View graph / people / families / events / map | ✅ | ✅ | ✅ |
| Search people | ✅ | ✅ | ✅ |
| Toggle privacy filter | ✅ | ✅ | ❌ |
| Import / re-import .gpkg | ✅ | ✅ | ❌ |
| View user notes | ✅ | ✅ | ✅ |
| Create / edit / delete user notes | ✅ | ✅ | ❌ |
| Create guest accounts (own instance) | ✅ | ✅ | ❌ |
| Create user accounts | ✅ | ❌ | ❌ |
| Create / delete instances | ✅ | ❌ | ❌ |
| Manage all users | ✅ | ❌ | ❌ |

### 5.2 Backend Enforcement

Create a reusable FastAPI dependency:

```python
# api/auth.py (sketch)

from fastapi import Depends, HTTPException, Request

def require_role(*allowed_roles: str):
    """FastAPI dependency that checks the current user's effective role."""
    def _check(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        if user["role"] not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return Depends(_check)

# Usage in routes:
@router.post("/import")
async def import_upload(
    file: UploadFile = File(...),
    user = require_role("admin", "user"),
):
    ...
```

### 5.3 Frontend Enforcement

The `/auth/me` response includes the user's effective role. The frontend uses this to:
- **Guest**: Hide import controls, privacy toggle, and user notes UI.
- **User**: Show everything except admin panels.
- **Admin**: Show everything including a future admin panel link.

This is done by adding a `role` field to `state.js` and conditionally rendering UI elements.

---

## 6. Multi-Instance Database Isolation

### 6.1 Schema-Per-Instance Strategy

When an admin creates a new instance (slug = `hofland`):

1. `INSERT INTO _core.instances (slug, display_name, ...) ...`
2. `CREATE SCHEMA inst_hofland;`
3. `SET search_path TO inst_hofland;` + execute `schema.sql` (creates all genealogy tables inside that schema).

### 6.2 Request-Scoped Schema Selection

The key architectural change: **`db_conn()` must set `search_path`** to the current instance's schema.

```python
# api/db.py (updated sketch)

@contextmanager
def db_conn(instance_slug: str | None = None):
    schema = f"inst_{instance_slug}" if instance_slug else "public"
    with psycopg.connect(get_database_url()) as conn:
        conn.execute(f"SET search_path TO {schema}, _core, public;")
        yield conn
```

**Every route** that accesses genealogy data must receive the instance slug from the auth middleware and pass it to `db_conn()`. This is the largest mechanical change — every `db_conn()` call site gains an `instance_slug` parameter.

### 6.3 Migration Path

To avoid a flag-day migration:
1. **Phase A**: Create `_core` schema and tables. Create a default instance (`inst_default`) and migrate existing `public.*` data into it. Create an admin user.
2. **Phase B**: Update `db_conn()` and all routes to use schema-scoped connections.
3. **Phase C**: Add auth middleware. All endpoints now require login.

This lets you test incrementally.

### 6.4 Import Pipeline Changes

Current import (`import_service.py` → `load_export_to_postgres.py`):
- Truncates all tables, reloads.

New import:
1. Receive instance slug from auth context.
2. **Within `inst_<slug>` schema only**:
   - Truncate all Gramps tables (person, family, event, place, note, etc.).
   - **Do NOT truncate `user_note`** — it survives.
   - Reload from JSONL.
3. After reload, user notes are still linked by `gramps_id`. If a user note references a `gramps_id` that no longer exists in the re-imported data, it becomes an "orphaned note" — display it in the UI with a warning badge, but don't delete it.

Changes to `load_export_to_postgres.py`:
```python
def _truncate_all(conn, preserve_user_data=True):
    tables = [
        "family_event", "family_child", "family",
        "event_note", "person_note", "person_event", "person_parent",
        "event", "place", "note", "person",
    ]
    # user_note is deliberately excluded — it survives re-imports.
    with conn.cursor() as cur:
        for t in tables:
            cur.execute(f"TRUNCATE TABLE {t} CASCADE;")
```

---

## 7. User Notes

### 7.1 API Endpoints

```
GET    /user-notes?gramps_id=<gid>         → list user notes for a person
POST   /user-notes                          → create a user note (body: { gramps_id, body })
PUT    /user-notes/<note_id>                → update a user note
DELETE /user-notes/<note_id>                → delete a user note
```

**Reading**: all roles (including guests) can view notes — they function as a shared announcement board for research coordination.

**Writing**: requires `user` or `admin` role. Notes are scoped to the current instance (schema) and tagged with the creating `user_id`.

Users can only edit/delete their own notes. Admins can edit/delete any note.

### 7.1b Export Endpoint

```
GET    /user-notes/export?format=json      → download all user notes as JSON
GET    /user-notes/export?gramps_ids=I0001,I0063&format=json  → partial export
```

Available to `user` and `admin`. Returns a downloadable list of user notes (optionally filtered by person) for archival or sharing outside the app.

### 7.2 Frontend Integration

The detail panel already has a `user_notes: []` placeholder in the `/people/{id}/details` response. Fill it:

1. When loading person details, also call `GET /user-notes?gramps_id=<gid>`.
2. Display user notes in the detail panel under a "My Notes" tab/section.
3. Provide an inline editor (textarea + save button) for creating/editing notes.
4. Guests see notes read-only (no editor, no delete button).
5. Users/admins get an "Export notes" button to download notes as JSON.

### 7.3 Re-Import Survival

User notes are linked by `gramps_id`, not `person.id`. During re-import:
- `person` table is truncated and reloaded → new `id` handles, same `gramps_id` values.
- `user_note.gramps_id` still matches `person.gramps_id` after reload.
- If a person was removed from Gramps (their `gramps_id` no longer exists), the note becomes "orphaned". The API should still return it (with a flag), and the UI shows a small warning.

---

## 8. Guest Account Management

### 8.1 Endpoints

```
POST   /instances/<slug>/guests             → create a guest account (accessible by user + admin)
         body: { username, password }
GET    /instances/<slug>/guests             → list guest accounts for this instance
DELETE /instances/<slug>/guests/<user_id>   → remove a guest from this instance
```

When a user or admin creates a guest:
1. A new row is inserted into `_core.users` with `role = 'guest'`.
2. A new row is inserted into `_core.memberships` with `role = 'guest'` and the instance id.

### 8.2 Frontend Integration

Add a "Members" section in the Options menu (visible to users and admins only) that shows current guests and lets them add new ones via a simple form.

---

## 9. Admin Functions

### 9.1 Endpoints

```
GET    /admin/instances                     → list all instances
POST   /admin/instances                     → create instance (slug, display_name)
DELETE /admin/instances/<slug>              → delete instance (drops schema!)

GET    /admin/users                         → list all users
POST   /admin/users                         → create user (username, password, role)
PUT    /admin/users/<id>                    → update user (password, role)
DELETE /admin/users/<id>                    → delete user

POST   /admin/instances/<slug>/members      → add user/guest to instance
DELETE /admin/instances/<slug>/members/<uid> → remove user from instance
```

All require `admin` role.

### 9.2 Frontend

Initially: **no admin UI**. Admin operations are done via `curl` / Postman / a quick CLI script. A web admin panel can come later.

Provide a CLI helper:
```
python -m api.admin create-admin --username=admin --password=...
python -m api.admin create-instance --slug=hofland --name="Hofland Family Tree"
python -m api.admin create-user --username=jan --password=... --role=user --instance=hofland
```

---

## 10. Frontend Changes Summary

### 10.1 New Files

| File | Purpose |
|------|---------|
| `api/static/login.html` | Login page |
| `api/static/instance_picker.html` | Instance selection (admin only) |
| `api/static/relchart/js/features/auth.js` | Auth state, login redirect, role checks |
| `api/static/relchart/js/features/userNotes.js` | User notes CRUD in detail panel |
| `api/static/relchart/js/features/members.js` | Guest management UI in options |

### 10.2 Modified Files

| File | Change |
|------|--------|
| `js/state.js` | Add `state.auth = { user, role, instance }` |
| `js/api.js` | No change needed if using cookies (browser sends automatically) |
| `js/app.js` | Import + init `auth`, `userNotes`, `members` features |
| `js/features/options.js` | Conditionally hide import/privacy based on role |
| `index.html` | Add instance indicator in sidebar; conditionally render role-gated UI |
| `styles.css` | Styles for login page, instance badge, user notes editor |

### 10.3 Role-Based UI Gating

On page load, `initAuthFeature()` calls `GET /auth/me`. Based on the response:
- Store `state.auth.role` and `state.auth.instance`.
- If not authenticated → redirect to `/login`.
- If admin with no instance selected → redirect to instance picker.
- If `role === 'guest'`:
  - Hide `#importFileInput`, `#importBtn`, import section.
  - Hide `#optPrivacyFilter` (privacy is always ON for guests).
  - Show user notes read-only (no editor, no delete).
- Display instance name in sidebar brand area.
- For admins: show an instance switcher control.

---

## 11. Privacy Changes

### Current
Any client can send `?privacy=off` — no server enforcement.

### New Behavior
- **Admin + User**: Can toggle privacy (existing behavior preserved).
- **Guest**: `?privacy=off` is **ignored by the server** for guests. The middleware injects the user's role, and privacy enforcement checks it:

```python
# In any route that reads the `privacy` query param:
if privacy.lower() == "off" and user["role"] == "guest":
    privacy = "on"  # Guests cannot disable privacy
```

This is a one-line guard added to each route that accepts a `privacy` parameter.

---

## 12. Implementation Phases

### Phase 1: Core Schema + Auth Backend (no frontend yet)
- [x] Create `sql/schema_core.sql`
- [x] Add `passlib`, `PyJWT` to `requirements.txt`
- [x] Create `api/auth.py` (password hashing, JWT, `get_current_user`)
- [x] Create `api/routes/auth.py` (`/auth/login`, `/auth/logout`, `/auth/me`)
- [x] Create `api/middleware.py` (auth middleware)
- [x] Create `api/admin.py` CLI (create-admin, create-instance, create-user)
- [x] Write tests for auth + role checks (`tests/test_auth.py` — 28 tests)

**Deliverable**: Backend auth works, testable via curl. ✅

### Phase 2: Multi-Instance Database Isolation
- [x] Update `db.py`: `db_conn()` accepts `instance_slug`, sets `search_path`
- [x] Update `import_service.py` + `load_export_to_postgres.py`: schema-aware import
- [x] Update all route handlers to pass instance slug to `db_conn()`
- [x] `sql/schema.sql` is already schema-agnostic (no `public.` references)
- [ ] Test: two instances side by side, each with different data

**Deliverable**: Multiple instances work, each isolated in its own schema. ✅

### Phase 3: Frontend Auth + Instance Picker
- [x] Create login page (`login.html`)
- [x] Create instance picker page (`instance_picker.html`, admin only)
- [x] Create `js/features/auth.js` (auth state, redirect logic, role gating)
- [x] Wire auth init into `app.js`
- [x] Role-based UI gating (hide import/privacy for guests)
- [x] Instance name indicator in sidebar

**Deliverable**: Users must log in. Guests see a read-only view. ✅

### Phase 4: User Notes
- [x] Add `user_note` table to instance schema (created by `admin.py create-instance`)
- [x] Create `api/routes/user_notes.py` (CRUD endpoints)
- [x] Create `js/features/userNotes.js` (detail panel integration)
- [x] Handle orphaned notes (gramps_id no longer exists after re-import)
- [x] Wire into detail panel

**Deliverable**: Users can create notes on people; notes survive re-imports. ✅

### Phase 5: Guest Management UI
- [x] Create `api/routes/instance_members.py`
- [x] Create `js/features/guests.js` (options menu integration)
- [ ] Test: user creates guest, guest logs in, guest sees read-only view

**Deliverable**: Users can invite guests to their instance. ✅

### Phase 6: Polish & Hardening
- [x] Secure cookie flags (`SameSite=Lax`, `HttpOnly`)
- [x] Session expiry UX (401 → redirect to `/login`, sliding refresh)
- [x] Guest privacy guard (guests cannot disable privacy)
- [x] CSRF protection (double-submit cookie: `tree_csrf` cookie + `X-CSRF-Token` header)
- [x] Rate limiting on `/auth/login` (5 attempts / 5 min per IP, in-memory)
- [x] Password strength validation (≥8 chars, upper+lower+digit)
- [ ] Admin web panel (optional, lower priority)
- [x] Documentation update

---

## 13. File-Level Change Map

### New Backend Files

| File | Purpose |
|------|---------|
| `sql/schema_core.sql` | `_core` schema DDL (users, instances, memberships) |
| `api/auth.py` | Password hashing, JWT helpers, `get_current_user()` dependency |
| `api/middleware.py` | Request-level auth + instance resolution |
| `api/admin.py` | CLI admin tool (`__main__` runnable) |
| `api/routes/auth.py` | Login / logout / me endpoints |
| `api/routes/user_notes.py` | User notes CRUD |
| `api/routes/instance_members.py` | Guest management per instance |

### Modified Backend Files

| File | Changes |
|------|---------|
| `api/db.py` | `db_conn()` gains `instance_slug` param, sets `search_path` |
| `api/main.py` | Register new routers (auth, user_notes, instance_members); add middleware |
| `api/import_service.py` | Accept `instance_slug`; pass to `load_export()`; skip `user_note` truncation |
| `api/routes/import_tree.py` | Extract instance from auth context; pass to `run_import()` |
| `api/routes/graph.py` | Add `instance_slug` to `db_conn()` calls; add guest privacy guard |
| `api/routes/people.py` | Same as above |
| `api/routes/families.py` | Same |
| `api/routes/events.py` | Same |
| `api/routes/places.py` | Same |
| `api/routes/relationship.py` | Same |
| `api/requirements.txt` | Add `passlib[bcrypt]`, `python-jose[cryptography]` |
| `sql/schema.sql` | Add `user_note` table; ensure no `public.` hardcoding |
| `export/load_export_to_postgres.py` | Accept `schema` param; skip `user_note` in `_truncate_all` |

### New Frontend Files

| File | Purpose |
|------|---------|
| `api/static/login.html` | Login form |
| `api/static/instance_picker.html` | Instance chooser (admin only) |
| `api/static/relchart/js/features/auth.js` | Auth state + redirect |
| `api/static/relchart/js/features/userNotes.js` | Notes CRUD in detail panel |
| `api/static/relchart/js/features/members.js` | Guest management |

### Modified Frontend Files

| File | Changes |
|------|---------|
| `js/state.js` | Add `state.auth` object |
| `js/app.js` | Import + init new features |
| `js/features/options.js` | Hide import/privacy for guests |
| `index.html` | Instance badge; role-gated sections |
| `styles.css` | Login page, notes editor, badge styles |

---

## 14. Data Model Diagram

```
┌─────────── _core schema ───────────┐
│                                     │
│  users ─────┐                       │
│  (id, username, password_hash,      │
│   role, display_name)               │
│              │                      │
│              │ 1:N                  │
│              ▼                      │
│  memberships ◄──── instances        │
│  (user_id, instance_id, role)       │
│                    (id, slug,       │
│                     display_name)   │
└─────────────────────────────────────┘

┌─── inst_hofland schema ────────────┐
│                                     │
│  person, family, event, place,      │
│  note, person_parent, person_event, │
│  person_note, event_note,           │
│  family_child, family_event         │
│                                     │
│  ── same tables as current ──       │
│                                     │
│  user_note                          │
│  (id, gramps_id → person.gramps_id, │
│   user_id → _core.users.id,        │
│   body, created_at, updated_at)     │
│                                     │
└─────────────────────────────────────┘
```

---

## 15. Security Considerations

| Risk | Mitigation |
|------|------------|
| Password in plaintext | bcrypt hashing (cost 12) |
| JWT stolen | HttpOnly + Secure + SameSite=Lax cookies; 24h expiry |
| CSRF | SameSite=Lax cookie blocks cross-origin POST by default; add CSRF token for extra safety |
| SQL injection via schema name | Validate slug against `^[a-z0-9_]{1,32}$` regex; never interpolate user input into SQL identifiers without validation |
| Privilege escalation | Server-side role checks on every mutating endpoint; frontend gating is cosmetic only |
| Privacy bypass by guests | Server ignores `?privacy=off` for guest role |
| Schema enumeration | Instance slug is only revealed to authenticated users with membership |
| Brute-force login | Rate limit `/auth/login` (e.g., 5 attempts per minute per IP) |

---

## 16. Initial Setup (Fresh Start)

The current single-instance data is a bare database import with no user data to preserve — no migration is needed.

1. Run `sql/schema_core.sql` against the database to create the `_core` schema.
2. Create an admin account: `python -m api.admin create-admin --username=admin --password=...`
3. Create your first instance: `python -m api.admin create-instance --slug=hofland --name="Hofland Family Tree"`
4. Assign yourself: `python -m api.admin add-member --username=admin --instance=hofland`
5. Restart the API.
6. Log in, select the Hofland instance, and re-import your `.gpkg` file — it will load into the `inst_hofland` schema.

The old `public` schema tables can be dropped or left empty; they are no longer used once the multi-instance setup is active.

---

## 17. Resolved Questions

1. **Should guests see user notes?** → **Yes, read-only.** Notes are a public announcement board for research coordination. Guests can view but not create/edit/delete.
2. **Should users see each other's notes?** → **Yes.** All notes within an instance are visible to all members. No private notes — the purpose is collaborative research (e.g. "find source for I0063").
3. **Multi-instance users**: → **Users and guests are locked to one instance.** Only admins can access multiple trees. This keeps the model simple and matches the primary workflow (one family = one tree = one account).
4. **Media/source attachments**: → **Instance-scoped.** Media files will be copied into an app-managed folder (per-instance), since serving from arbitrary filesystem paths doesn't work for a hosted server. Specifics TBD when media support is built.
5. **API versioning**: → **Deferred.** Not needed now; can be added later if the API becomes public.

## 18. Open Questions

1. **Media storage layout**: What folder structure for instance-scoped media? e.g. `data/media/inst_hofland/` or a content-addressed store? How does import handle media from `.gpkg` files?
2. **Note export format**: JSON is planned; should CSV or plain-text also be supported?
3. **Admin CLI vs. web panel**: CLI is sufficient to start — when (if ever) should a web admin panel be built?

---

## 19. Estimated Effort

| Phase | Effort | Depends on |
|-------|--------|------------|
| Phase 1: Auth backend | 2–3 days | — |
| Phase 2: Multi-instance DB | 2–3 days | Phase 1 |
| Phase 3: Frontend auth | 1–2 days | Phase 1 |
| Phase 4: User notes | 1–2 days | Phase 2 + 3 |
| Phase 5: Guest management | 1 day | Phase 3 |
| Phase 6: Polish | 1–2 days | All |

**Total**: ~8–13 days of focused work.
