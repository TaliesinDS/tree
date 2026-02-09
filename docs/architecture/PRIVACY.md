# Privacy rules (server-side, current)

Goal: the site is public, but living (or otherwise private) people are **redacted server-side**. The frontend must assume anything it receives is safe to show.

## Public vs private

- **Public:** historical/deceased people and their non-sensitive fields.
- **Private:** living people and any record explicitly marked private.

Private people still exist as nodes so relationships can be navigated, but their personal fields are redacted.

## Effective privacy decision (as implemented)

The API decides whether to redact a person using (in order):

1) `is_private` → always private
2) `is_living_override` / `is_living` / death date
	- if `is_living_override` is set, it wins
	- else if `is_living` is set, it is respected
	- else if a death date exists (or a credible death year can be parsed), the person is treated as not living
3) If living is still **unknown**, use a conservative birth-based heuristic:
	- if birth date is unknown (and no credible year can be parsed from `birth_text`) → private
	- else if born on or after **1946-01-01** → private
	- else if age is less than **90 years** → private
	- otherwise → public

These thresholds are defined in `api/privacy.py`:
- `_PRIVACY_BORN_ON_OR_AFTER = 1946-01-01`
- `_PRIVACY_AGE_CUTOFF_YEARS = 90`

## Neighborhood graph-only “historic unredaction” heuristic

When rendering the neighborhood graph (`GET /graph/neighborhood`), the API applies an extra, bounded heuristic to avoid false “Private” cards in old/undated parts of the tree:

- If a person has no usable date/year hints and is privacy-redacted by the base policy,
- but they are within a small number of parent/child hops of a clearly historic *already-public* person,
- then they may be treated as public for that neighborhood payload.

This is intentionally bounded (small hop limit) and does **not** override explicit `is_private` or explicit living flags.

## Redaction behavior

When a person is private:
- `display_name` becomes `"Private"`
- date fields are removed/redacted
- endpoints that would otherwise leak associated relationships/notes must not return them

## Why server-side matters

Anything sent to the browser is effectively public, so privacy must be enforced before JSON leaves the API.

## Client-side privacy toggle

All privacy-sensitive API endpoints accept an optional `privacy=off` query parameter. When present, the endpoint skips the `_is_effectively_private` check and returns unredacted data.

### Frontend UX

- The **Options menu** includes a "Privacy filter" checkbox (default: checked / ON).
- When unchecked, a `withPrivacy(url)` helper in `api.js` appends `privacy=off` to every API call.
- An amber **"Privacy off"** pill badge appears in the top bar next to the status bar.
- Toggling **reloads the graph** and **invalidates cached sidebar data** (people, families, events) so the next tab visit re-fetches with the new setting.
- The toggle is **never persisted** — refreshing the page always resets privacy to ON.

### Affected endpoints

The `privacy=off` query parameter is respected by:
- `GET /graph/neighborhood`
- `GET /graph/family/parents`
- `GET /graph/family/children`
- `POST /graph/places`
- `GET /people` (list)
- `GET /people/{id}`
- `GET /people/{id}/details`
- `GET /people/{id}/relations`
- `GET /people/search`
- `GET /families`
- `GET /events/{id}`
- `GET /events` (list)

### Implementation

- Backend: each endpoint accepts `privacy: str = "on"` as a query param. When `privacy.lower() == "off"`, the `_is_effectively_private` call is skipped (or `skip_privacy=True` is passed to `_person_node_row_to_public`).
- Frontend: `api.js` exports `withPrivacy(url)` which reads `state.privacyFilterEnabled` and appends `privacy=off` when the filter is disabled. All `fetch()` calls in feature modules use this wrapper.
- Files: `api/static/relchart/js/features/options.js` (toggle wiring), `api/static/relchart/js/api.js` (URL injection).
