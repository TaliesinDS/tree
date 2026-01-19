# Copilot Instructions for Tree (Gramps Genealogy Viewer)

This file provides project-specific context for GitHub Copilot. It is automatically included in every Copilot chat for this workspace.

## Project Overview

**Tree** is a **view-only** genealogy browser that visualizes data exported from Gramps Desktop. It is NOT an editing platform.

- **Source of truth**: Gramps Desktop (export via `.gramps`/`.gpkg`)
- **Backend**: FastAPI + PostgreSQL/PostGIS (read-only API with server-side privacy enforcement)
- **Frontend**: Browser-based graph viewer using Graphviz WASM

## Architecture Versions (IMPORTANT)

This repo contains **three architecture iterations**. Only v3 is actively maintained:

| Version | Path | Status |
|---------|------|--------|
| v1 | `/demo/graph`, `graph_demo.html` | **Legacy** - do not modify |
| v2 | `/demo/viewer`, `viewer_ported.html` | **Legacy** - do not modify |
| **v3** | `/demo/relationship`, `api/static/relchart/` | **Active** - all new work here |

When working on the viewer, **always use the relchart v3 files** under `api/static/relchart/`.

## Key Files (relchart v3)

### Frontend (no-build ES modules)
- `api/static/relchart/index.html` — UI shell
- `api/static/relchart/styles.css` — styling
- `api/static/relchart/js/app.js` — main app logic, expansion handling
- `api/static/relchart/js/api.js` — fetch wrappers for API endpoints
- `api/static/relchart/js/chart/dot.js` — **DOT generation** (payload → Graphviz DOT string)
- `api/static/relchart/js/chart/render.js` — **SVG post-processing** (Graphviz SVG → interactive chart)
- `api/static/relchart/js/chart/graphviz.js` — Graphviz WASM loader
- `api/static/relchart/js/chart/panzoom.js` — viewBox-based pan/zoom
- `api/static/relchart/js/chart/payload.js` — payload merge utilities
- `api/static/relchart/js/chart/lineage.js` — **ancestor/descendant line tracing** for edge highlighting

### Backend
- `api/main.py` — FastAPI endpoints, privacy filtering, graph queries
- `api/db.py` — database connection helper
- `sql/schema.sql` — PostgreSQL schema

## Two-Phase Layout Architecture

The graph rendering has **two distinct phases**:

### Phase 1: DOT Generation (`dot.js`)
- Converts API payload (`{nodes, edges}`) into Graphviz DOT language
- Creates clusters for couples (`cluster_couple_<fid>`)
- Handles multi-spouse ordering, sibling grouping, single-parent families
- DOT is a **declarative constraint language** — Graphviz globally optimizes node positions

### Phase 2: SVG Post-Processing (`render.js`)
- Takes Graphviz SVG output and enhances it
- Adds click handlers, expand indicators, rim styling
- Moves/adjusts nodes (hubs, junctions) for visual polish
- Smooths edge paths (`convertEdgeElbowsToRoundedPaths`)

**Critical insight**: These phases have different capabilities:
- DOT constraints are **suggestions** to a global optimizer — they can be overridden
- SVG post-processing gives **direct control** but requires updating dependent geometry

## Hard-Won Lessons (from persistent bugs)

### 1. DOT is a Global Optimizer
Local node/edge attributes (`width`, `minlen`, etc.) can be overridden by:
- Conflicting subgraph constraints
- Global settings like `nodesep=0`
- Competing cluster pressures

**Implication**: For fine-tuned spacing, prefer SVG post-processing over DOT tricks.

### 2. SVG Movement Requires Edge Re-Snapping
If you move a node in SVG post-processing, **you MUST update edge endpoints** or edges will visually disconnect.

Pattern:
```javascript
// Track all movements
personDxById.set(nodeId, deltaX);

// Later, in edge smoothing:
if (personDxById.get(sourceId)) ends.source.x += personDxById.get(sourceId);
if (personDxById.get(targetId)) ends.target.x += personDxById.get(targetId);
```

### 3. Bounding Box Math in SVG
`getBBox()` **ignores transforms** — it returns local coordinates only.

**Correct approach** for user-space coordinates:
```javascript
const r = el.getBoundingClientRect();
const inv = svg.getScreenCTM().inverse();
// Transform screen coords back to SVG user-space via inv
```

### 4. Single-Parent Family Constraint Interference
When a person is both:
- A spouse in a two-parent family, AND
- The sole visible parent of a single-parent family

...DOT's constraint solver can compress the couple's horizontal spacing. This requires SVG-level correction (spouse nudging with edge re-snap).

### 5. Test with Specific Problematic Payloads
Generic test cases may not trigger constraint interference bugs. Always test with:
- `GET /graph/neighborhood?id=I0063&depth=5` (triggers F1592 edge case)
- Multi-spouse scenarios
- Single-parent families in view

## Graph Model

The API supports two graph shapes (prefer `family` for readability):

- `layout=family`: Family hub nodes (⚭) connect spouses and children
- `layout=direct`: Person-only graph with parent/partner edges (tangles more easily)

### Node Types
- **Person node**: `{ id, type: 'person', display_name, gender, birth, death, ... }`
- **Family hub**: `{ id, type: 'family', parents_total, children_total, has_more_children, ... }`

### Edge Types
- `parent`: person → family (spouse/parent relationship)
- `child`: family → person (child relationship)

## API Endpoints (commonly used)

```
GET /graph/neighborhood?id=<person_id>&depth=<n>&max_nodes=<n>&layout=family
GET /graph/family/parents?family_id=<fid>&child_id=<pid>
GET /graph/family/children?family_id=<fid>&include_spouses=true
GET /people/{id}
GET /people/search?q=<query>
```

## Privacy Model

Privacy is **enforced server-side** (anything sent to browser is public):
- `is_private` flag → always private
- `is_living_override` → explicit override from Gramps
- `is_living` flag → from Gramps export

**Privacy decision logic** (in order):
1. If `is_private` → private
2. If effectively living (has `is_living` flag or no death date):
   - Born on or after **1946-01-01** → private
   - Age < **90 years** → private
   - Otherwise → public
3. Unknown birth date with unknown living status → **private** (conservative)

Key constants in `api/main.py`:
```python
_PRIVACY_BORN_ON_OR_AFTER = date(1946, 1, 1)
_PRIVACY_AGE_CUTOFF_YEARS = 90
```

Private persons get `display_name: "Private"` and redacted dates.

## Development Environment

- **OS**: Windows
- **Shell**: PowerShell (not bash)
- **Python**: Use `.venv\Scripts\python.exe` (not bare `python`)
- **API restart task**: "genealogy: restart api (detached 8080)"

### Quick Commands
```powershell
# Restart API
# Use VS Code task: "genealogy: restart api (detached 8080)"

# Or manually:
$env:DATABASE_URL = "postgresql://postgres:polini@localhost:5432/genealogy"
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8080
```

## Testing the Viewer

1. Open `http://127.0.0.1:8080/demo/relationship`
2. Default load: person `I0063`, depth `5`
3. Click person cards to select, click family hubs to select (not expand)
4. Use expand indicators (▲/▼ tabs) to expand parents/children

## Bug Logs (historical reference)

- `FID_MISALIGNMENT_BUGLOG.md` — hub alignment/float issues (v1-v2 era)
- `F1592_COUPLE_SPACING_BUGLOG.md` — single-parent constraint interference (v3, resolved)

These contain detailed root cause analysis and failed approaches — consult before attempting similar fixes.

## What NOT to Do

- Don't modify legacy viewers (`viewer_ported.html`, `graph_demo.html`)
- Don't use `minlen=1` for horizontal spacing in DOT (it affects vertical rank)
- Don't move SVG nodes without tracking offsets for edge re-snapping
- Don't weaken single-parent anchoring edges (causes "float to top row" bug)
- Don't use `getBBox()` alone for cross-transform coordinate math
