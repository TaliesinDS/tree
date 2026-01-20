# Relationship chart architecture (relchart)

This document explains the **relationship chart** frontend that lives under `/demo/relationship` and why the project moved to this approach.

The intent is to make it easy for the next AI (or future you) to immediately answer:
- Where is the relationship chart implemented?
- What API shape does it expect?
- Why Graphviz WASM (again), and why this modular structure?
- What parts are inspired by Gramps Web, and what did we intentionally simplify?

## What this chart is (scope)

This chart is a **focused, Graphviz-driven “family hub” view** used for:
- readable genealogy layout (couples + marriage hub + children)
- interactive “carve-a-path” expansion (expand parents / expand children)
- quick debugging of graph payloads and multi-family edge cases

It is *not* the long-term “full app UI”. It’s a stable, modular demo frontend that we can evolve into the real UI later.

## Why we moved to this approach

We previously had large, monolithic demo viewers (e.g. `viewer_ported.html`) that mixed:
- graph fetching
- layout logic
- SVG post-processing
- UI controls
- interaction state

That made iteration slow and made it hard for a new model to safely change one thing without breaking another.

The `relchart` approach is a conscious shift to:
- **no-build ES modules** (served directly from FastAPI static)
- small files with single responsibilities
- stable, explicit data contract against the API endpoints

### Why Graphviz WASM for this view

Genealogy charts have strong structural constraints that Graphviz DOT handles very well:
- stable generation ordering (top-to-bottom)
- readable couple grouping
- predictable “hub” positioning

Dagre/D3 approaches can work for exploration layouts, but the classic Gramps-like “relationship chart” (couples + hub + children) becomes much easier when Graphviz is doing the layout.

We keep Graphviz WASM **limited to this chart**, and keep other exploration layouts free to use Dagre or future Canvas/WebGL strategies.

## Relationship to Gramps Web (inspiration)

This chart is inspired by how **Gramps Web** renders its relationship chart:
- Build an internal graph model
- Generate DOT (with clusters / couple semantics)
- Run Graphviz (WASM) to produce an SVG layout
- Post-process ("remaster") the SVG into interactive elements

In Gramps Web this lives in `src/charts/RelationshipChart.js` and uses `@hpcc-js/wasm` + D3 helpers.

Tree’s `relchart` intentionally simplifies this:
- We use Graphviz WASM via `@hpcc-js/wasm-graphviz` from a CDN (no bundler step).
- We generate DOT directly from the API payload (no Gramps-specific “rules” query layer).
- We do targeted SVG post-processing: attach click handlers, draw expand badges, and smooth edge paths.

## Entry points and file layout

The route is served by FastAPI:
- `GET /demo/relationship` → `api/static/relchart/index.html`

Files:
- `api/static/relchart/index.html`: UI shell (tabs/sidebar) + chart container
- `api/static/relchart/styles.css`: styling for the shell and the chart container
  - The chart container now includes layered viewports:
    - `#graphView`: Graphviz-rendered SVG goes here
    - `#mapView`: Leaflet map goes here
    - Cross-fade is driven by `#chart[data-main-view="graph"|"map"]`

JavaScript modules:
- `api/static/relchart/js/app.js`
  - entrypoint + wiring (initial load + feature initialization)
  - keeps the module boundaries explicit (minimal logic)
- `api/static/relchart/js/api.js`
  - tiny fetch wrappers:
    - `/graph/neighborhood?layout=family`
    - `/graph/family/parents`
    - `/graph/family/children`
    - person lookups used by sidebar/details panels
- `api/static/relchart/js/chart/dot.js`
  - `buildRelationshipDot(payload)` (payload → DOT string)
  - encodes “couple row” semantics by placing father → hub → mother in a same-rank cluster
- `api/static/relchart/js/chart/graphviz.js`
  - loads Graphviz WASM once (CDN import)
- `api/static/relchart/js/chart/panzoom.js`
  - viewBox-based pan/zoom for the generated SVG
- `api/static/relchart/js/chart/payload.js`
  - payload merge (`mergeGraphPayload`)
  - compute expansion opportunities from the payload:
    - `computeHiddenParentFamiliesByPersonId`
    - `computeHiddenChildFamiliesByPersonId`
- `api/static/relchart/js/chart/lineage.js`
  - **Ancestor/descendant line tracing utilities** for future edge-highlighting features
  - `traceAncestorLine(payload, rootId, { preferGender })` — trace direct paternal ('M') or maternal ('F') line
  - `traceDescendantLine(payload, rootId)` — trace first-child line downward
  - `getEdgesForLine(payload, personIds, familyIds)` — get edges connecting a traced line
  - See the file's JSDoc for usage examples
- `api/static/relchart/js/chart/render.js`
  - render pipeline (DOT → Graphviz SVG → attach interactions + badges)

Feature modules (UI behavior):
- `api/static/relchart/js/state.js` — shared state and element refs
- `api/static/relchart/js/features/graph.js` — chart render + expand + selection sync
- `api/static/relchart/js/features/people.js` — people sidebar
- `api/static/relchart/js/features/families.js` — families sidebar
- `api/static/relchart/js/features/events.js` — events sidebar
- `api/static/relchart/js/features/places.js` — places sidebar + place-events panel
- `api/static/relchart/js/features/map.js` — Leaflet initialization + pins
- `api/static/relchart/js/features/detailPanel.js` — person detail panel
- `api/static/relchart/js/features/tabs.js` — tab switching + topbar mode
- `api/static/relchart/js/features/keybinds.js` — keyboard shortcuts
- `api/static/relchart/js/features/options.js` — options menu + people list width toggle

Shared utilities:
- `api/static/relchart/js/util/clipboard.js`
- `api/static/relchart/js/util/event_format.js`

## Data contract with the backend

The relationship chart is currently driven by the *existing graph endpoints*.

### 1) Seed payload

The chart loads:
- `GET /graph/neighborhood?id=<Ixxxx_or_handle>&depth=<n>&max_nodes=<n>&layout=family`

Required payload shape:
- `nodes`: array of `{ id, type: 'person'|'family', ... }`
- `edges`: array of `{ from, to, type: 'parent'|'child', role? }`

Person fields used by the DOT label builder:
- `display_name`, `given_name`, `surname`
- `birth`, `death`
- `gender` (used for subtle styling)

Family fields used for affordances:
- `parents_total` (for “can this family have parents?”)
- `children_total` / `has_more_children` (for “can this family have more children?”)

### 2) Incremental expansion payloads

Expand-up (parents of a family hub):
- `GET /graph/family/parents?family_id=<family>&child_id=<person>`

Expand-down (children of a family hub):
- `GET /graph/family/children?family_id=<family>&include_spouses=true`

Both return the same `{nodes, edges}` shape so the frontend can `mergeGraphPayload` and re-render.

## Rendering pipeline (high level)

1) Fetch payload (neighborhood or expansion)
2) Build DOT from payload (`buildRelationshipDot`)
3) Graphviz WASM lays out DOT into an SVG string
4) Inject SVG into the chart container
5) Enable pan/zoom (viewBox transform)
6) Attach click handlers:
   - click person → select
  - click family hub → select (no expand or recenter)
  - selection updates status with both API id + Gramps id and copies them to clipboard
7) Compute “hidden relatives” signals from payload metadata and add small badges on person cards:
   - `↑` when there is a birth-family hub with missing parent edges in-view
   - `↓` when a parent-family hub has more children than currently in-view

## Map view (current MVP)

The Map tab uses a lightweight Leaflet map (OpenStreetMap raster tiles) rendered in the **same main viewport** as the Graph.

Implementation notes:
- Leaflet is lazy-loaded from a CDN on first Map-tab open.
- Switching tabs cross-fades between `#graphView` and `#mapView` (CSS opacity + pointer-events).
- Places list click behavior:
  - clicking the **row/box** selects/highlights and (if expandable) toggles open/closed, but does **not** move the map
  - clicking the **place name text** copies the place id + breadcrumb and also centers/drops a marker on the map (when coords exist)

### Map pins performance note (Current graph scope)

The `Scope: Current graph` mode needs “places referenced by events for the people in the visible neighborhood”.

Do **not** implement this as N sequential `/people/{id}/details` calls; it becomes very slow even for ~50–200 people.

Instead, use the bulk endpoint:

- `POST /graph/places` with `{ person_ids: [...], limit }` → `{ results: [place...], total }`

This returns distinct public places (with coordinates) for privacy-safe events.

### UI layering gotcha (topbar vs overlays)

The topbar uses `position: sticky` and a z-index, which creates a stacking context. Dropdown panels inside the topbar can end up rendering **under** other fixed overlays (like the person detail panel) even if their own z-index is high.

Current solution:

- The person detail panel is allowed to float above the topbar.
- Topbar dropdown panels (Options, Map Pins, Map Routes) are “portaled” to `document.body` while open and positioned with `position: fixed`.

If you add new topbar popovers, follow the same pattern or you’ll reintroduce z-index bugs.

## Key tradeoffs (explicit)

- **No bundler:** deliberate. This keeps iteration fast and avoids maintaining an npm toolchain for the demo.
- **CDN dependency:** Graphviz WASM is loaded from unpkg (`@hpcc-js/wasm-graphviz@1.18.0`). Pinning the version avoids surprise breakages.
- **Re-layout on every expansion:** acceptable for now (demo). If this becomes the main UI, we may want caching or partial re-layout.

## Known limitations (current)

- Expand badges currently choose the “first” hidden family if multiple exist; there is no chooser UI yet.
- Labels are DOT HTML labels; styling is constrained by what DOT supports without heavy SVG remastering.
- Very large graphs may be slow to lay out client-side (Graphviz WASM).

## Next improvements (high ROI)

- Badge chooser: if multiple hidden families, open a small menu rather than picking index 0.
- Add lightweight “selected person” styling (outline) after click.
- Add optional portrait circles once the backend exposes stable portrait URLs.
- Add sanitized fixtures for deterministic dev (so this chart can run without a DB/API).
