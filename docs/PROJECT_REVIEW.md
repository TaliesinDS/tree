# Project review (Tree)

Purpose: an honest, actionable critique of Tree as a software project (quality, risks, and high‑ROI improvements), written like feedback from a friendly developer/teacher.

Last updated: 2026-01-20

---

## 1) What the project is (and why it’s a good idea)

Tree is a **view-only genealogy browser** that visualizes Gramps exports in the browser, backed by a read-only FastAPI API and PostgreSQL/PostGIS.

This is a strong concept because:
- Gramps is a good “source of truth” editor, but its sharing UX is not “public website friendly”.
- A public viewer requires **server-side privacy enforcement** (not “hide it in the UI”).
- Genealogy queries (graph traversal, full-text search in notes, spatial queries for places) realistically need a backend and database.

The repo communicates this well in the root README/HANDOFF and keeps the “no editing” boundary clear.

---

## 2) What’s strong / above average

### A) Architecture direction is solid
- Choosing Graphviz WASM + DOT for the relationship chart is a *good fit* for genealogical constraints.
- The “two-phase layout” mental model (DOT constraints first, then SVG post-processing) is correct and shows you understand the real behavior of Graphviz.
- Keeping legacy viewers as “do not modify” and focusing on v3 avoids the classic trap of spreading fixes across three generations of demos.

### B) Documentation quality is unusually good
This repo has the kind of docs that most hobby projects never reach:
- A clear doc index (`docs/README.md`) with conventions.
- An explicit architecture doc for relchart.
- Debug buglogs that capture hard-earned lessons.

This isn’t “nice to have”; it’s the difference between a project you can continue in 6 months vs. one you abandon.

### C) Privacy is treated as a first-class requirement
Your privacy approach is conservative and server-side. That’s the correct stance for a public genealogy viewer.

---

## 3) What’s weak / what will hurt you later

I’ll be blunt here, because you asked for “no glazing”.

### A) You have “god files” now
Two files are already large enough that they behave like mini-codebases:
- `api/static/relchart/js/app.js` (~5k+ lines)
- `api/main.py` (~3k+ lines)

That is not automatically “bad”, but it creates predictable problems:
- regressions when adding features (because everything touches everything)
- fear of refactoring (“don’t touch it, it might break”) which slows progress
- onboarding cost for you-in-3-months (not just other people)

Concrete example from recent work: you had a feature (global search) that worked in the detail panel but changed behavior in the People tab depending on load order. That kind of issue is exactly what large glue files tend to produce.

### B) Minimal automated tests (high risk for privacy + graph logic)
From the repo structure, there’s no obvious test suite.

For a project with:
- privacy rules,
- graph traversal,
- payload merge correctness,

…not having tests means you’ll eventually “fix” something and silently break a rule that matters.

Even a small test set would pay for itself quickly.

### C) Frontend maintainability risk: state + UI + map + lists all in one place
The relchart v3 module split is good overall, but `app.js` still mixes:
- global state store
- fetch orchestration
- DOM manipulation/rendering for lists
- map initialization + pin logic
- detail panel UI

This makes the file hard to reason about and encourages patchy fixes.

### D) Performance ceiling (Graphviz WASM)
You already understand this, but it’s worth stating:
- Graphviz WASM will not scale indefinitely.
- Re-layouting on every expand works now, but large graphs will require either:
  - smaller “windowed” graphs,
  - caching,
  - partial/approx layouts,
  - or a different rendering path for “strategic overview”.

This isn’t a dealbreaker; it’s just a boundary to design around.

### E) CDN + no-build is pragmatic but has long-term costs
No-build ES modules are great for iteration speed.
The cost is:
- dependency pinning and reproducibility become your responsibility
- offline / long-term reproducible builds are harder

This is acceptable if you keep versions pinned and treat it as a conscious trade.

---

## 4) High-ROI fixes (what I would do next)

If you only do a few things next, do these.

### 1) Split `app.js` into feature modules (biggest maintainability win)
Goal: keep the current behavior, but move code into obvious “units”.

Suggested modules:
- `js/state.js` (shared `state`, `els`, helpers)
- `js/features/people.js` (people index load, render, selection sync)
- `js/features/places.js` (places list render, place selection, events panel)
- `js/features/map.js` (leaflet init, overlay/pins/routes, map selection syncing)
- `js/features/detailPanel.js` (panel skeleton, tabs, search popover)
- `js/features/status.js` (status bar, clipboard helpers)

Keep `app.js` as the entrypoint that wires the modules together.

Why this matters:
- reduces “accidental coupling”
- makes regressions easier to localize
- makes it easier to add features without breaking unrelated tabs

### 2) Add a tiny test suite focused on correctness-sensitive rules
You don’t need a big testing framework rewrite. A small set is enough.

Backend tests to start with (highest value):
- privacy decision cases (living/private redaction)
- name normalization/formatting edge cases

Frontend tests: optional for now, but you can add a few fixture-based checks (e.g., payload merge behavior) later.

### 3) Add deterministic fixtures for known “problem graphs”
You already have known-bad payloads/IDs.
Capture a few sanitized JSON payload fixtures so you can:
- reproduce layout/expand bugs without the full DB
- validate that merges/expansions do not introduce weird states

### 4) Make boundaries explicit: “API raw vs API formatted”
You currently do some display-driven normalization server-side.
That’s OK, but it’s worth being deliberate about it:
- either document that the API is “UI-shaped”,
- or add parallel fields/params later (raw + formatted) if you ever need it.

### 5) Introduce lightweight linting/formatting and stick to it
Not because “style matters”, but because consistency reduces cognitive load.
- Black/ruff for Python
- a minimal JS formatter (or just disciplined manual style)

---

## 5) Concrete warnings (things to avoid)

- Avoid adding more UI features directly into `app.js` unless you’re also carving out modules.
- Avoid Graphviz DOT hacks for pixel-perfect spacing where SVG post-processing is the right tool.
- Avoid moving SVG nodes without also re-snapping edge endpoints (you documented this lesson correctly; it’s worth repeating because it’s a permanent footgun).

---

## 6) Suggested “next 2 weeks” checklist

### Week 1 (stabilize)
- [ ] Create `js/features/*` modules and move code without behavior change
- [ ] Add a few backend tests (privacy + name formatting)
- [ ] Add 1–2 saved fixture payloads for UI regression reproduction

### Week 2 (reduce regressions)
- [ ] Centralize selection events (person + place) so every feature uses the same path
- [ ] Add a small “smoke test” script/doc for dev sanity checks (load demo URLs, verify core interactions)

---

## 7) Summary (the honest teacher grade)

This is an unusually strong solo project in terms of architecture intent and documentation.
The main technical weakness is not your ideas—it’s file-level organization and the lack of tests around rules that matter (privacy + graph correctness).
If you invest in modularizing and a minimal test/fixture setup now, the project will keep getting easier to extend instead of harder.

---

## 8) Expanded recommendations and additions (2026-01-20)

*Cross-checked and expanded by a second reviewer.*

The above analysis is accurate. Here are **additions, expansions, and concrete implementation details** that the original review didn't cover or could benefit from specificity.

---

### 8.1) Backend modularization (missed in original)

The original review focuses on frontend `app.js` but **`api/main.py` (2,755 lines)** deserves the same treatment. Suggested split:

| New file | Contents | Why |
|----------|----------|-----|
| `api/privacy.py` | `_is_effectively_private`, `_is_effectively_living`, `_PRIVACY_*` constants | Makes privacy logic testable in isolation; single audit point |
| `api/names.py` | `_smart_title_case_name`, `_normalize_public_name_fields`, `_format_public_person_names`, `_NAME_LOWER_PARTICLES`, `_ROMAN_NUMERALS` | Name formatting is a self-contained domain |
| `api/graph.py` | `_bfs_neighborhood`, `_bfs_neighborhood_distances`, `_fetch_neighbors`, `_fetch_spouses`, graph endpoint handlers | Isolates graph traversal algorithms |
| `api/queries.py` | Bulk fetch helpers (`_people_core_many`, `_fetch_family_marriage_date_map`, etc.) | Reusable query patterns |

Keep `main.py` as the FastAPI app + route registration only.

**Concrete first step:** Extract `api/privacy.py` (~150 lines). This is the highest-value extraction because:
- Privacy is the most critical correctness requirement
- It's completely self-contained (no FastAPI dependencies)
- It becomes immediately testable

---

### 8.2) Expanded test recommendations

The original says "add tests" but doesn't specify *how* given the current setup. Here's a concrete plan:

#### A) Create `tests/` folder with pytest

```
tests/
├── __init__.py
├── conftest.py           # shared fixtures
├── test_privacy.py       # privacy rule tests
├── test_names.py         # name formatting tests
└── fixtures/
    └── payloads/
        └── I0063_depth5.json  # known-problem graph
```

#### B) Priority test cases for `test_privacy.py`

```python
# These are the actual edge cases from your privacy logic:

def test_private_flag_always_private():
    """is_private=True overrides everything."""
    
def test_born_after_1946_is_private():
    """Person born 1946-01-01 or later with no death -> private."""
    
def test_born_before_1946_over_90_is_public():
    """Person born 1930 (age 96 today) with no death -> public."""
    
def test_born_before_1946_under_90_is_private():
    """Person born 1940 (age 86 today) with no death -> private."""
    
def test_death_date_makes_public():
    """Person with death_date is not living -> public (unless is_private)."""
    
def test_unknown_birth_unknown_living_is_private():
    """Conservative: no birth date + unknown living status -> private."""
    
def test_living_override_true_forces_living():
    """is_living_override=True treats person as living regardless of death_date."""
    
def test_birth_year_from_text_fallback():
    """birth_text='abt 1920' should parse year for privacy calc."""
```

#### C) Add to `requirements.txt` (dev section)

```
pytest>=7.0
pytest-cov  # optional, for coverage
```

#### D) Run tests command

```powershell
.\.venv\Scripts\python.exe -m pytest tests/ -v
```

---

### 8.3) Frontend module split: concrete file boundaries

The original suggests module names. Here's a more specific breakdown of what moves where:

#### `js/state.js` (~100 lines)
```javascript
// Move from app.js:
export const els = { /* all $('id') refs */ };
export const state = { /* entire state object */ };
export const MAP_SETTINGS = { /* localStorage keys */ };
export function _readBool(key, fallback) { ... }
export function _readInt(key, fallback) { ... }
export function _writeSetting(key, value) { ... }
```

#### `js/features/people.js` (~400 lines)
```javascript
// Move: people list rendering, search, expand toggle, selection sync
// Functions: _renderPeopleList, _filterPeopleList, people search handlers
// Dependencies: imports state, els from state.js
```

#### `js/features/map.js` (~800 lines)
```javascript
// Move: ALL Leaflet/map code
// Functions: _ensureLeaflet, _applyBasemap, _ensureOverlayLayers, 
//            _renderMapPins, _renderMapRoutes, _getPersonDetailsCached
// This is a natural boundary because map code has its own state (state.map, state.mapUi)
```

#### `js/features/detailPanel.js` (~600 lines)
```javascript
// Move: detail panel open/close, tab switching, drag/resize, 
//       person details fetch, events/notes rendering
// Functions: _openDetailPanel, _closeDetailPanel, _renderDetailPanelContent,
//            detail panel drag handlers, search popover
```

#### `js/features/topbar.js` (~300 lines)
```javascript
// Move: topbar popover portaling logic, options menu handlers
// Functions: _portalDetailsPanel, _unportalDetailsPanel, _closeMapPopovers
// This is isolated DOM manipulation that doesn't need to live in app.js
```

**Migration strategy:**
1. Create the files with function stubs that re-export from app.js
2. Move one function at a time, test manually after each
3. Don't try to do it in one commit

---

### 8.4) API boundary clarification (expand on original #4)

The original mentions "API raw vs formatted" but doesn't give specifics. Here's what to document:

#### Currently UI-shaped fields (server does formatting):
- `display_name` -> title-cased with particle handling
- `given_name`, `surname` -> normalized (epithet handling)
- `birth`, `death` -> text strings, not ISO dates
- Private persons -> `display_name: "Private"`, all other fields nulled

#### Recommendation: add a `?raw=true` query param
For debugging and future flexibility, consider:
```
GET /people/I0001?raw=true  -> returns DB values as-is
GET /people/I0001           -> returns formatted/redacted values (current behavior)
```

This is low priority but worth noting in architecture docs.

---

### 8.5) Performance boundaries to document (expand on original 3D)

The original mentions Graphviz WASM limits. Concrete numbers to capture:

| Scenario | Current behavior | Known limit |
|----------|------------------|-------------|
| Neighborhood depth=3 | Fast (<500ms layout) | ~100-200 nodes |
| Neighborhood depth=5 | Acceptable (1-3s layout) | ~500-800 nodes |
| Neighborhood depth=7+ | Likely slow/unusable | Not tested |
| Full 4k-person graph | Will not work with current approach | Need alternative |

**Recommendation:** Add a `MAX_NODES` constant in app.js (currently 1000) and document why it exists.

---

### 8.6) Missing: error handling audit

Neither review mentions this, but the codebase has inconsistent error handling:

#### Backend
- Some endpoints return `HTTPException(404)` for missing data
- Some return empty results silently
- No structured error response format

**Recommendation:** Define a consistent error envelope:
```json
{ "error": { "code": "NOT_FOUND", "message": "person not found: I9999" } }
```

#### Frontend
- Fetch errors sometimes show in status bar, sometimes silent
- No retry logic for transient failures

**Recommendation:** Add a `showError(msg)` helper and use it consistently.

---

### 8.7) Missing: dependency pinning documentation

The original mentions CDN pinning but doesn't specify what's pinned. Document this:

| Dependency | Version | Source | Notes |
|------------|---------|--------|-------|
| `@hpcc-js/wasm-graphviz` | 1.18.0 | unpkg CDN | Graphviz WASM |
| Leaflet | 1.9.4 | unpkg CDN | Map rendering |
| psycopg | 3.x | pip | Postgres driver |
| FastAPI | 0.x | pip | Web framework |

**Recommendation:** Add a `DEPENDENCIES.md` or a comment block in `index.html` listing pinned versions with dates.

---

### 8.8) Missing: SQL migration strategy

The schema uses `ADD COLUMN IF NOT EXISTS` for migrations, which works but:
- No version tracking
- No down migrations
- No way to know what schema version a DB has

For a solo project this is fine, but if you ever need to coordinate schema changes:
- Consider adding a `schema_version` table
- Or adopt Alembic (may be overkill)

---

### 8.9) Expanded 2-week checklist

The original checklist is good but vague. Here's a more specific version:

#### Week 1: Foundation

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Create `api/privacy.py`, move privacy functions | File exists, main.py imports from it |
| 2 | Create `tests/test_privacy.py` with 5 core cases | `pytest tests/test_privacy.py` passes |
| 3 | Create `js/state.js`, move state/els/settings | app.js imports from state.js, no behavior change |
| 4 | Create `js/features/map.js`, move map code | Map tab still works |
| 5 | Save `fixtures/payloads/I0063_depth5.json` | File exists, can be loaded in browser console |

#### Week 2: Consolidation

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Create `js/features/detailPanel.js` | Detail panel still works |
| 2 | Create `js/features/people.js` | People tab still works |
| 3 | Add `test_names.py` with 5 edge cases | Tests pass |
| 4 | Add `showError()` helper, use in 3 places | Errors show consistently |
| 5 | Update HANDOFF.md with new file layout | Doc reflects reality |

---

### 8.10) Things to explicitly NOT do

The original has a "warnings" section. Adding:

- **Don't add TypeScript yet.** The no-build approach is working. TypeScript would require a build step and slow iteration. Maybe later.
- **Don't add a state management library (Redux/Zustand).** The current `state` object is fine for this scale. A library would add complexity without benefit.
- **Don't over-engineer the test suite.** 10-20 focused tests beats 100 flaky tests. Test the rules that matter (privacy, merges), not every function.
- **Don't refactor and add features simultaneously.** Pick one. Refactoring should be behavior-preserving; features should land in the new structure.

---

## 9) Final assessment (combined)

| Area | Original rating | Revised | Notes |
|------|-----------------|---------|-------|
| Purpose/concept | 4/5 | 4/5 | Agree |
| Backend code | 3/5 | 3/5 | Agree; main.py needs same split treatment as app.js |
| Frontend code | 3/5 | 3/5 | Agree |
| Documentation | 5/5 | 5/5 | Agree; this is genuinely excellent |
| Testing | 2/5 | 2/5 | Agree; highest-risk gap |
| Architecture | 4/5 | 4/5 | Agree |

**Bottom line:** The original review is accurate. The project is solid conceptually but needs the modularization and test work described above to stay maintainable as features grow.
