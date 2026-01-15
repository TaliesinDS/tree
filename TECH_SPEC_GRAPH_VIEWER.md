# Tech Spec: Interactive Graph Viewer (Graphviz + D3, view-only)

## 0) Context / intent

This project is a **view-only** genealogy browser inspired by Gramps Web, driven by data exported from Gramps Desktop. It is not intended to be an editing platform.

Two distinct graph experiences are required:

- **Default exploration (performance-first):** limited node budget for smooth interaction.
- **Strategic overview (whole-tree / extreme mode):** used to scan the overall tree for gaps, duplicated people (localized names), and patterns, with aggressive level-of-detail.

This spec answers: *which features require what* (Graphviz vs D3 vs SVG/Canvas/WebGL, and which backend endpoints are implied).

In addition to the graph, the UI includes a left sidebar for:
- People index (grouped by surname)
- Events search/filter
- Map view (places + event-linked markers with filtering/selection)
- Portrait images mirrored from Gramps-linked media files

## 1) Non-goals

- Editing people/families/events/sources.
- Collaborative multi-user editing.
- Real-time updates.

## 2) Terminology

- **Person node:** a human.
- **Family hub (optional but recommended):** a node representing a union/marriage/relationship, used to connect two spouses and their children in a stable and readable way.
- **Edge kinds:**
  - `parent` (child → parent)
  - `spouse` (person ↔ person) OR `family` edges (person → familyhub, familyhub → child)

## 3) Feature → requirements matrix

### 3.1 Pan/zoom like a map

Required:
- **Frontend:** pan/zoom transform of a single root container (no re-layout).
- **D3:** `d3-zoom` is ideal (but not strictly required; you can write your own).
- **Renderer:** SVG is fine for default mode; Strategic may need LOD.

Current implementation note (demo):
- The `/demo/viewer` prototype uses viewBox-based pan/zoom (pointer-drag + wheel zoom).
- Because the SVG uses `preserveAspectRatio="xMinYMin meet"`, pan math must account for letterboxing so vertical dragging stays 1:1.

Not required:
- Graphviz does not handle interaction; it only helps with initial layout.

### 3.2 Click to select + show details panel

Required:
- **Frontend:** click handlers on nodes.
- **Backend:** `GET /person/<id>` (minimal payload for fast UI updates).

Optional:
- Preload minimal person payload within the graph nodes to avoid a roundtrip.

### 3.3 Double-click to open detail modal

Required:
- **Frontend:** dblclick handler.
- **Backend:** `GET /person/<id>/details` (richer payload: events, notes, sources).

### 3.4 Pin(s) + relationship highlighting

Two related UX flows:

1) **Single pin (Pin A) + selection**
- Pin one person.
- Clicking another person highlights the route from selected → pinned.

2) **Two pins (Pin A + Pin B)**
- Pin two people and run a relationship query between them.
- Provide a query toggle:
  - `route` (show route(s) between A and B)
  - `shared_ancestor` (highlight common ancestor(s) and paths A→ancestor and B→ancestor)
  - `shared_descendant` (highlight common descendant(s) and paths A→descendant and B→descendant)

Required:
- **Backend pathfinding:**
  - for single-pin “route”: `GET /graph/path?from=<id>&to=<id>&mode=blood|any`
  - for two-pin queries: `GET /graph/relationship?a=<id>&b=<id>&query=route|shared_ancestor|shared_descendant&mode=blood|any&max_results=10&max_depth=20`
- **Frontend:** maintain `pinnedA`, `pinnedB`, `selected`, and `relationshipQuery` state; render highlight overlay for returned nodes/edges.

UX add-on: “Pins notepad” (waypoints)
- In addition to path-highlighting pins, support a lightweight waypoint list:
  - a quick action on a node/card (context menu or pin icon) adds that person to a toolbar pin list
  - click a pin to jump/recenter to that person without removing already-rendered graph content
  - one-click clear-all pins

Algorithm notes (backend):
- `route`:
  - compute shortest path (or k-shortest paths if you want multiple routes) on the chosen edge set.
- `shared_ancestor`:
  - compute ancestor sets of A and B up to a depth/era limit
  - intersect
  - rank results (prefer “closest” shared ancestor by minimal max-distance)
  - return two paths (A→ancestor, B→ancestor) per result
- `shared_descendant`:
  - symmetric idea but in the descendant direction
  - must be bounded (`max_depth`, `max_results`) to avoid blowups

Graphviz/D3 requirements:
- Graphviz is not required for pathfinding.
- D3 is not required, but convenient for event wiring and toggling highlight styles.

### 3.5 Click-to-refocus (“focus window” jump)

Behavior:
- In default mode, clicking a person (optionally) triggers a refresh that redraws the subgraph around that person, e.g. 4 generations.

Required:
- **Backend:** `GET /graph/subgraph?center=<id>&generations=<n>&include_spouses=1&max_people=<budget>`
- **Frontend:** replace current graph dataset + rerender.

Graphviz requirements:
- If layout is computed server-side, this endpoint should return stable positions (see section 5).

### 3.6 Carve-a-path expansion (incremental growth)

Behavior:
- Start from a seed graph.
- Expand only when the user clicks a dead-end/cul-de-sac.

Required:
- **Backend (proposed):** `POST /graph/expand` returning **only new nodes/edges**.
- **Backend (current prototype):** targeted expand endpoints used by `/demo/viewer`:
  - `GET /graph/family/parents?family_id=<family>&child_id=<child>` (expand up)
  - `GET /graph/family/children?family_id=<family>&include_spouses=true` (expand down)
- **Frontend:** merge incremental nodes/edges into the current dataset.

Renderer requirements:
- SVG still OK if node budget stays bounded.
- Avoid global re-layout if possible; prefer local append + minor adjustments.

### 3.7 Strategic overview mode (whole-tree scan)

Primary goals:
- Scan large areas quickly to find:
  - gaps (missing parents/spouse/children in eras where you expect continuity)
  - duplicate-person candidates (localized names for the same individual)

Required:
- **Backend:** a large graph endpoint with minimal payload per node:
  - `GET /graph/strategic?max_people=4000&fields=min&include_private=0`
- **Frontend:** aggressive level-of-detail (LOD): hide most text until zoomed in.

Optional:
- **Backend signals:** `GET /graph/strategic/signals?era_start=700&era_end=1100`.

Renderer choice:
- If SVG already performs acceptably at ~2261 nodes / ~2278 edges in the current demo, SVG is viable for Strategic up to ~4k *if* you do LOD.
- If Strategic grows beyond that (or you want buttery-smooth), plan an optional Canvas/WebGL renderer.

### 3.8 Left sidebar views (Graph / People / Events / Map)

These are alternative lenses on the same underlying dataset.

Required:
- **Frontend:** persistent sidebar with view switching and an explicit scope selector:
  - `scope=current_graph` (only currently loaded subgraph)
  - `scope=all` (entire dataset)
- **Backend:** list/search endpoints that can be constrained by scope.

Not required:
- Graphviz is not required for sidebar list/map functionality.

### 3.9 People index (grouped by surname)

Required:
- **Backend:** people listing endpoint that returns at least: `id`, `given_name`, `surname`, optional `birth_year`, optional `death_year`.
- **Frontend:** grouped list UI (A–Z), click-to-focus/select in graph.

Optional:
- Fast typeahead search within the index.

### 3.10 Events search + filters

Required:
- **Backend:** events listing/search endpoint supporting:
  - full-text query
  - event type filter
  - year range filters
  - location filter
  - person constraints (surname, descendants-of, ancestors-of)

Implementation hints:
- Postgres full-text search is ideal.

### 3.11 Map view (places + markers + selection-as-filter)

Required:
- **Data:** all places have coordinates (lat/lon). Events should reference places where possible.
- **Frontend:** map library (e.g. Leaflet) and a marker layer.
- **Backend:** marker endpoint supporting filters, optionally bounded by viewport (`bbox`).

Selection workflow:
- User selects a set of markers (click / lasso / rectangle).
- UI can convert selection → a filter applied to People/Events/Graph.

Backend requirement for selection-as-filter:
- Either accept a list of ids (place_ids / event_ids / person_ids), or accept a geometry/bbox.

### 3.12 Portrait images mirrored from Gramps (including crop)

Goal:
- Gramps stores portraits as links to local filesystem files (not embedded in the DB).
- The app should mirror these images into app-managed storage and apply the Gramps crop.

Required:
- **Export/import data:** for each person portrait:
  - source file path
  - crop rectangle (`x,y,w,h`) and its coordinate system (pixels vs normalized)
  - original width/height if crop is normalized
- **Backend pipeline:** a sync step that copies/dedupes originals and generates derived portraits.
- **Frontend:** display portrait thumbnails in graph nodes and larger versions in person details.

Edge cases:
- missing source files → placeholder + report
- changed source files → detect and regenerate
- out-of-bounds crop → clamp
- privacy policy may restrict serving portraits for living/private individuals

## 4) Recommended frontend architecture (avoid rewrite)

### 4.1 Keep the “scene model” renderer-agnostic

Maintain a single in-memory model:
- `nodesById`
- `edges`
- selection state: `selectedPersonId`, `pinnedPersonId`, `mode` (default/strategic), `zoomTransform`

Then implement two renderers behind it:
- `SvgRenderer` (current path; fast to ship)
- optional future: `CanvasRenderer` / `WebGLRenderer`

If you do this separation, adding D3 now is not wasted time: `d3-zoom` remains useful even if the renderer changes.

### 4.2 D3 usage recommendation

Use D3 for:
- `d3-zoom` (pan/zoom)
- event wiring patterns (optional)

Avoid D3 force-layout. Family trees are better handled by a deterministic layout (Graphviz or precomputed coordinates).

### 4.3 SVG performance tactics (important for Strategic)

- Put everything under one `<g>` and apply transforms to that group.
- LOD:
  - at low zoom: hide all text labels (or show only on hover)
  - hide heavy node interiors (render as simple rects/dots)
  - reduce edge styling (no expensive filters)
- Consider limiting per-frame work:
  - don’t recompute geometry on pan; only on dataset changes

## 5) Layout strategy (Graphviz’s role)

Graphviz is best treated as a **layout engine**:
- input: nodes/edges
- output: stable `(x,y)` coordinates for nodes + edge routes

### Option A: Server-side layout (recommended first)

- Backend runs Graphviz when:
  - generating a subgraph (default focus window)
  - generating Strategic overview (potentially cached)
- Backend returns positions:
  - `node: {id, x, y, ...}`
  - `edge: {from, to, kind, points:[...]} ` (optional; or let the client draw straight lines)

Pros:
- Predictable, deterministic, consistent across clients.

Cons:
- Bigger payload if you include edge geometry.

### Option B: Precomputed global coordinates

If Strategic becomes a core activity, consider storing a persistent layout:
- compute once for the entire dataset
- persist `(x,y)` per person (and optionally per family hub)

This makes map-like exploration feel stable across sessions.

## 6) Backend API (proposed)

### 6.1 Graph endpoints

- `GET /graph/subgraph`
  - query: `center`, `generations`, `include_spouses`, `max_people`
  - returns: bounded graph (nodes+edges), optionally with layout coords

- `POST /graph/expand`
  - body: `{ seed_person_ids, seed_family_ids, already_have_person_ids, max_people_delta }`
  - returns: incremental nodes/edges only

Concrete expand endpoints (implemented in the API and used by `/demo/viewer`):
- `GET /graph/family/parents?family_id=<family>&child_id=<child>`
- `GET /graph/family/children?family_id=<family>&include_spouses=true`

- `GET /graph/path`
  - query: `from`, `to`, `mode=blood|any`
  - returns: ordered `node_ids` and/or explicit edges for highlight

- `GET /graph/relationship`
  - query: `a`, `b`, `query=route|shared_ancestor|shared_descendant`, `mode=blood|any`, optional bounds like `max_results`, `max_depth`
  - returns: highlight plan:
    - `meeting_nodes` (e.g. ancestor ids)
    - `paths` (each path is a node list and/or explicit edges)

- `GET /graph/strategic`
  - query: `max_people`, `fields=min|...`, `include_private`
  - returns: large graph with minimal node payload

- `GET /graph/strategic/signals` (optional)
  - query: `era_start`, `era_end`
  - returns: lists of ids for overlays (gaps, dup candidates)

### 6.2 People endpoints

- `GET /people`
  - query: `scope=current_graph|all`, optional filters like `surname_prefix`, `surname`, `q`, `year_min`, `year_max`
  - returns: list of people suitable for grouping in the sidebar

### 6.3 Events endpoints

- `GET /events`
  - query: `scope=current_graph|all`, `query`, `type`, `year_min`, `year_max`, `place`, `surname`, `descendants_of`, `ancestors_of`
  - returns: events list for sidebar + links to people/places

### 6.4 Map endpoints

- `GET /map/markers`
  - query: `type=events|people|places`, optional `bbox`, plus filters:
    - `surname`, `year_min`, `year_max`, `descendants_of`, `ancestors_of`, `event_type`
  - returns: marker list with `lat`, `lon`, and ids

### 6.5 Media/portrait endpoints + pipeline

Serving:
- `GET /media/portraits/<person_id>.jpg` (or static file mapping)

Sync pipeline (CLI or internal admin endpoint; view-only app can keep it manual):
- `POST /admin/media/sync-portraits` (optional)
  - scans people with portrait references, mirrors files, generates crops, returns a report

### 6.6 Person endpoints

- `GET /person/<id>`
  - minimal payload used for hover/selection UI

- `GET /person/<id>/details`
  - richer payload used by modal

## 7) What requires Canvas/WebGL?

Nothing in your feature list *requires* Canvas/WebGL.

Canvas/WebGL becomes attractive if:
- Strategic goes beyond ~4k–8k nodes, or
- you want consistently buttery pan/zoom while showing lots of labels and edges.

Given current results (~2261 nodes is “more than well enough”), the no-regrets path is:
- ship SVG + D3 interactions now
- keep rendering isolated so Canvas/WebGL is an optional upgrade, not a rewrite
