# Implementation Plan: Tests & Code Modularization

**Created:** 2026-01-20  
**Last Updated:** 2026-01-20  
**Goal:** Address the two main recommendations from PROJECT_REVIEW.md:
1. Split the "god files" (`api/main.py` and `app.js`) into focused modules
2. Add automated tests for privacy logic and critical rules

**Status (as of 2026-01-20):**
- Backend modularization is complete: `api/main.py` is now wiring-only (~35 lines) and endpoints live under `api/routes/`.
- Backend tests are implemented (`tests/test_privacy.py`, `tests/test_names.py`, plus graph payload regression/contract tests).
- Frontend modularization is mostly complete (`api/static/relchart/js/app.js` is ~433 lines and primarily wiring).
- Completed frontend extractions:
    - `api/static/relchart/js/state.js`
    - `api/static/relchart/js/util/dom.js`
    - `api/static/relchart/js/features/portal.js`
    - `api/static/relchart/js/features/people.js`
    - `api/static/relchart/js/features/families.js`
    - `api/static/relchart/js/features/map.js`
    - `api/static/relchart/js/features/graph.js`
    - `api/static/relchart/js/features/detailPanel.js`
    - `api/static/relchart/js/features/places.js`
    - `api/static/relchart/js/features/events.js`
    - `api/static/relchart/js/features/tabs.js`
    - `api/static/relchart/js/features/keybinds.js`
- `api/static/relchart/js/app.js` is updated to import and initialize these modules.

---

## Phase 1: Backend Modularization (DONE)

Break `api/main.py` (~2,755 lines) into focused modules.

### Step 1.1: Extract `api/privacy.py` (DONE)

**What to move:**
```python
# Constants
_PRIVACY_BORN_ON_OR_AFTER = date(1946, 1, 1)
_PRIVACY_AGE_CUTOFF_YEARS = 90

# Functions
def _is_effectively_living(p: dict, today: date) -> bool
def _is_effectively_private(p: dict, today: date) -> bool
```

**Why first:** Privacy is the most critical correctness requirement, completely self-contained (no FastAPI deps), and immediately testable.

**Files touched:**
- Create: `api/privacy.py`
- Edit: `api/main.py` (add import, remove moved code)

**Verification:** API still works (`/people/I0001` returns same response)

---

### Step 1.2: Extract `api/names.py` (DONE)

**What to move:**
```python
# Constants
_NAME_LOWER_PARTICLES = {"van", "de", "der", "den", "het", ...}
_ROMAN_NUMERALS = {"i", "ii", "iii", "iv", "v", ...}

# Functions
def _smart_title_case_name(s: str) -> str
def _normalize_public_name_fields(p: dict) -> dict
def _format_public_person_names(people: list[dict]) -> list[dict]
```

**Why:** Name formatting is a self-contained domain with its own edge cases.

**Files touched:**
- Create: `api/names.py`
- Edit: `api/main.py`

**Verification:** Names display correctly in UI (particles lowercase, Roman numerals correct case)

---

### Step 1.3: Extract `api/graph.py` (DONE)

**What to move:**
```python
# Graph traversal functions
def _bfs_neighborhood(...)
def _bfs_neighborhood_distances(...)
def _fetch_neighbors(...)
def _fetch_spouses(...)

# Graph endpoint handlers (optionally)
# Can also keep route handlers in main.py but call graph.py functions
```

**Why:** Isolates graph traversal algorithms from HTTP handling.

**Files touched:**
- Create: `api/graph.py`
- Edit: `api/main.py`

**Verification:** Graph loads correctly at `/demo/relationship`, expand works

---

### Step 1.4: Extract `api/queries.py` (DONE)

**What to move:**
```python
# Bulk fetch helpers
def _people_core_many(...)
def _fetch_family_marriage_date_map(...)
def _fetch_event_details(...)
# etc.
```

**Why:** Reusable query patterns that don't belong in route handlers.

**Files touched:**
- Create: `api/queries.py`
- Edit: `api/main.py`

**Verification:** All API endpoints return correct data

---

### Backend Module Structure (After Phase 1)

```
api/
├── main.py          # FastAPI app wiring only (~35 lines)
├── db.py            # Database connection (existing)
├── privacy.py       # Privacy logic (~150 lines)
├── names.py         # Name formatting (~200 lines)
├── graph.py         # Graph traversal (~400 lines)
└── queries.py       # Bulk query helpers (~300 lines)

api/routes/
├── demo.py
├── health.py
├── graph.py
├── people.py        # includes /people and /people/{id}
├── families.py      # /families
├── events.py        # /events
├── places.py        # /places and /places/events_counts
└── relationship.py  # /relationship/path
```

---

## Phase 2: Add Backend Tests (DONE)

### Step 2.1: Create test infrastructure (DONE)

**Create directory structure:**
```
tests/
├── __init__.py
├── conftest.py           # Shared fixtures
├── test_privacy.py       # Privacy rule tests
├── test_names.py         # Name formatting tests
└── fixtures/
    └── payloads/
        └── I0063_depth5.json  # Known-problem graph fixture
```

**Add to requirements.txt:**
```
pytest>=7.0
pytest-cov  # optional
```

---

### Step 2.2: Write privacy tests (`tests/test_privacy.py`) (DONE)

**Test cases to implement:**

| Test | Input | Expected |
|------|-------|----------|
| `test_private_flag_always_private` | `is_private=True` | Private |
| `test_born_after_1946_is_private` | `birth_date=1946-01-01`, no death | Private |
| `test_born_before_1946_over_90_is_public` | `birth_date=1930-01-01`, no death | Public |
| `test_born_before_1946_under_90_is_private` | `birth_date=1940-01-01`, no death | Private |
| `test_death_date_makes_public` | Has `death_date` | Public |
| `test_unknown_birth_unknown_living_is_private` | No birth date, unknown living | Private (conservative) |
| `test_living_override_true_forces_living` | `is_living_override=True` | Treated as living |
| `test_birth_year_from_text_fallback` | `birth_text="abt 1920"` | Parses year for privacy calc |

---

### Step 2.3: Write name formatting tests (`tests/test_names.py`) (DONE)

**Test cases to implement:**

| Test | Input | Expected |
|------|-------|----------|
| `test_particle_lowercase` | `"VAN DER BERG"` | `"van der Berg"` |
| `test_roman_numerals_uppercase` | `"willem iii"` | `"Willem III"` |
| `test_mixed_particles_and_numerals` | `"JAN VAN HOLLAND II"` | `"Jan van Holland II"` |
| `test_epithet_handling` | Person with epithet in surname | Correct placement |
| `test_empty_name_handling` | `""` or `None` | No crash |

---

### Step 2.4: Run tests command (DONE)

```powershell
# From repo root
.\.venv\Scripts\python.exe -m pytest tests/ -v
```

---

## Phase 3: Frontend Modularization (MOSTLY DONE)

Break `api/static/relchart/js/app.js` into focused modules.

### Step 3.1: Extract `js/state.js` (DONE)

**What to move:**
```javascript
export const els = { /* all element refs */ };
export const state = { /* entire state object */ };
export const MAP_SETTINGS = { /* localStorage keys */ };
export function _readBool(key, fallback) { ... }
export function _readInt(key, fallback) { ... }
export function _writeSetting(key, value) { ... }
```

**Why:** Shared state is the foundation other modules need.

---

### Step 3.2: Extract `js/util/dom.js` (DONE)

**What to move:**
- Small DOM helpers that are shared across features
- Example: `_cssEscape` and other tiny utilities

**Why:** Keeps feature modules small and prevents circular imports.

---

### Step 3.3: Extract `js/features/portal.js` (DONE)

**What to move:**
- The topbar/details popover “portaling” logic
- Helper like `_isInsideDetailsOrPortal` and portal/unportal functions

**Why:** This is a self-contained UI behavior used by multiple popovers.

---

### Step 3.4: Extract `js/features/people.js` (DONE)

**What to move:**
- People list rendering
- People search/filter
- Expand toggle
- Selection sync with graph

**Dependencies:** Imports from `state.js`

---

### Step 3.5: Extract `js/features/families.js` (DONE)

**What to move:**
- Families list rendering + virtualization
- Families search/filter UI wiring
- Family selection + scroll-to-selected behavior
- `ensureFamiliesLoaded()` and `setSelectedFamilyKey()`

**Why:** Families sidebar is independent from the relationship chart rendering.

---

### Step 3.6: Extract `js/features/map.js` (DONE)

**What to move:**
- ALL Leaflet/map code
- `_ensureLeaflet`, `_applyBasemap`, `_ensureOverlayLayers`
- `_renderMapPins`, `_renderMapRoutes`
- Map state (`state.map`, `state.mapUi`)

**Why:** Map code is a natural boundary with its own state.

---

### Step 3.6a: Extract `js/features/graph.js` (DONE)

**What to move:**
- Relationship chart rendering + re-rendering (`renderRelationshipChart` wiring)
- Expand handlers (parents/children) + payload merge
- SVG selection styling (selected person outline) and related DOM helpers
- View anchor capture/restore around expansion (keep clicked tab stable)

**Why:** Keeps `app.js` as mostly wiring and isolates graph behavior.

---

### Step 3.7: Extract `js/features/detailPanel.js` (DONE)

**What to move:**
- Detail panel open/close
- Tab switching
- Drag/resize handlers
- Person details fetch
- Events/notes rendering
- Search popover

---

### Step 3.8: Extract `js/features/places.js` (DONE)

---

### Step 3.9: Extract `js/features/events.js`, `tabs.js`, `keybinds.js` (DONE)

**What to move:**
- Events sidebar behavior (list rendering + selection)
- Tab switching/topbar mode
- Keyboard shortcuts

**Why:** Keeps the entrypoint focused on wiring.

**What to move:**
- Places list rendering
- Place selection
- Events panel for places

---

### Frontend Module Structure (After Phase 3)

```
api/static/relchart/js/
├── app.js              # Entrypoint + wiring (~500 lines)
├── api.js              # API fetch wrappers (existing)
├── state.js            # Shared state + settings (~100 lines)
├── util/
│   └── dom.js           # Shared DOM helpers
├── features/
│   ├── people.js       # People list (~400 lines)
│   ├── families.js     # Families list (~300-500 lines)
│   ├── portal.js       # Popover portaling helpers
│   ├── graph.js        # Graph rendering + selection/expand (~300-500 lines)
│   ├── tabs.js         # Tab switching + topbar mode (~150-250 lines)
│   ├── keybinds.js     # Keyboard shortcuts (~100-200 lines)
│   ├── events.js       # Events list (~200-400 lines)
│   ├── places.js       # Places list (~300 lines)
│   ├── map.js          # Map rendering (~800 lines)
│   └── detailPanel.js  # Detail panel (~600 lines)
└── chart/
    ├── dot.js          # DOT generation (existing)
    ├── render.js       # SVG post-processing (existing)
    ├── graphviz.js     # WASM loader (existing)
    ├── panzoom.js      # Pan/zoom (existing)
    ├── payload.js      # Payload merge (existing)
    └── lineage.js      # Edge highlighting (existing)
```

---

## Phase 4: Add Fixtures & Smoke Tests (NEXT)

### Step 4.1: Save known-problem payloads

Save JSON payloads for graphs known to trigger issues:

```
tests/fixtures/payloads/
├── I0063_depth5.json           # Medieval messy data
├── multi_spouse_example.json   # Multi-spouse layout test
└── single_parent_example.json  # Single-parent family test
```

**Purpose:** Reproduce layout/expand bugs without full DB access.

---

### Step 4.2: Create smoke test checklist

Create `tests/SMOKE_TEST.md`:

```markdown
# Manual Smoke Test Checklist

Run after any significant change:

## Graph
- [ ] Load `/demo/relationship` with default person
- [ ] Change depth to 5, verify graph loads
- [ ] Click expand-up arrow, verify parents load
- [ ] Click expand-down arrow, verify children load
- [ ] Select person, verify status bar shows IDs

## People Tab
- [ ] Verify surname groups load and are collapsible
- [ ] Search for a name, verify filtering works
- [ ] Click person in list, verify graph recenters

## Places Tab
- [ ] Verify places list loads
- [ ] Click place, verify events panel shows

## Map Tab
- [ ] Verify map loads
- [ ] Verify pins appear for events with coordinates
```

---

## Handoff: Fixtures + Smoke Tests (New Chat)

**Goal:** Finish the remaining “cleanup” work:
- Add on-disk graph fixtures + a manual smoke checklist for repeatable UI verification

**What’s already done:**
- Backend modules exist: `api/privacy.py`, `api/names.py`, `api/graph.py`, `api/queries.py`
- Backend tests exist: `tests/test_privacy.py`, `tests/test_names.py`, `tests/test_graph*.py`
- Frontend feature modules exist under `api/static/relchart/js/features/` and `app.js` is mostly wiring

**Next targets:**
1. **Fixtures:** Populate `tests/fixtures/payloads/` with a couple of known-problem neighborhood payload JSONs.
2. **Smoke checklist:** Add `tests/SMOKE_TEST.md` to make UI verification repeatable.

**Smoke check after backend consolidation:**
- Run `pytest tests/`.
- Restart API via the VS Code task “genealogy: restart api (detached 8080)”.
- Open `http://127.0.0.1:8080/demo/relationship` and verify graph + expand still work.

**Important project rules:**
- Only touch relchart v3 files under `api/static/relchart/`.
- If any SVG elements are moved during post-processing, edges must be re-snapped (see docs/debug notes).

---

## Migration Strategy

### Rules for safe refactoring:

1. **One module at a time** - Don't try to split everything in one commit
2. **No behavior changes** - Refactoring should be behavior-preserving
3. **Test after each move** - Verify manually before moving to next step
4. **Keep app.js/main.py as entrypoints** - They import from new modules

### Git workflow:

```powershell
# Create a branch for each phase
git checkout -b refactor/backend-modules

# Commit after each step
git commit -m "Extract api/privacy.py from main.py"

# Merge after phase is stable
git checkout main
git merge refactor/backend-modules
```

---

## Timeline Summary

| Phase | Duration | Outcome |
|-------|----------|---------|
| Phase 1: Backend modules | 3-4 days | `main.py` reduced to ~500 lines |
| Phase 2: Backend tests | 2-3 days | Privacy + name tests passing |
| Phase 3: Frontend modules | 4-5 days | `app.js` reduced to ~500 lines |
| Phase 4: Fixtures | 1 day | Smoke tests + JSON fixtures |
| **Total** | **~2 weeks** | Maintainable codebase with test coverage |

---

## What NOT to do

- ❌ **Don't add TypeScript yet** - No-build approach is working, TS would add complexity
- ❌ **Don't add state management library** - Current `state` object is fine at this scale
- ❌ **Don't over-engineer tests** - 10-20 focused tests beats 100 flaky tests
- ❌ **Don't refactor AND add features simultaneously** - Pick one per PR
- ❌ **Don't touch `dot.js` or `render.js` layout logic** - These are stable and documented

---

## Success Criteria

After completing this plan:

1. `api/main.py` is under 600 lines (route registration only)
    - Current: wiring-only (~35 lines) ✅
2. `app.js` is under 600 lines (module wiring only) ✅
3. `pytest tests/` passes ✅
4. Privacy rules are tested ✅
5. New features can be added without touching unrelated code
6. You can understand any module in isolation
