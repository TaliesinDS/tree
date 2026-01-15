# Feature mapping (what you want → backend capability)

This is a living mini-spec for the genealogy UI and the backend capabilities it implies.

See also: TECH_SPEC_GRAPH_VIEWER.md (feature → tech mapping and implementation notes).

## A) Two levels of exploration (default vs Strategic)
There are *two* graph experiences:

1) **Default exploration (performance-first)**
- Intentionally limits how many people are on screen.
- Used for normal browsing (focus window + carving paths).
- Priorities: responsiveness, readable labels, predictable interactions.

2) **Strategic overview (whole-tree / extreme mode)**
- Used when you want to see the true extent of the tree and scan for gaps/patterns.
- Example uses:
  - spotting “I forgot to fill this early medieval / Norman block”
  - noticing duplicate people across lines due to localized names (e.g. Wessex vs Swabia)
- Priorities: coverage, overview, pattern spotting (not full detail).

Both modes should feel like a “map” (pan/zoom), but they have very different constraints.

Rendering implication:
- Both modes should avoid a pure DOM-per-node approach.
- Practically: Canvas/WebGL rendering (or a hybrid with aggressive label culling).

## 1) Relationship / route path between 2 people (needed for “pin”)
DB representation:
- Store parent edges: `person_parent(child_id, parent_id)`.
- Store spouse/partner relationships explicitly OR via family hubs (see note below).

Implementation:
- Find shortest path with BFS.
- Options:
  - SQL recursive CTE (works well up to moderate graph sizes)
  - Python BFS with batched edge fetch (often simpler to tune)

Path modes (important for UX):
- **blood**: only parent/child edges (consanguinity)
- **any**: include spouse/partner edges too

API shape (suggestion):
- `GET /graph/path?from=<person_id>&to=<person_id>&mode=blood|any`
  - returns ordered `person_ids` and/or explicit `edges` to highlight

## 2) Default map explorer: pan/zoom with a capped node budget
Frontend behavior:
- Drag anywhere to pan (no relayout)
- Mouse wheel (or touchpad) zooms around cursor
- Optional “minimap” and/or “reset view”

Performance targets (acceptance criteria):
- Default mode stays smooth with a capped budget (e.g. a few hundred to ~1k nodes, TBD)
- Panning stays smooth and doesn’t trigger full re-layout
- Labels can be simplified at low zoom (LOD):
  - zoomed out: show dots/colored bands only
  - medium: show surname only
  - zoomed in: show full card

Backend implication:
- For this mode, the client needs a subgraph sized to the current “budget.”
- Prefer endpoints that can return a bounded subgraph quickly (and cache it).

API shapes (suggestion):
- `GET /graph/subgraph?center=<person_id>&generations=4&include_spouses=1&max_people=<budget>`

Return format (suggestion):
- nodes: `[{id, x, y, label_min, label_full, sex, private, ...}]`
- edges: `[{from, to, kind: 'parent'|'spouse'|'family'}]`

Note on layout:
- If we want stable “map-like” exploration, the layout needs stable coordinates.
- Options (not decided):
  - precompute a layout server-side and persist `(x,y)` per person
  - compute layout on the client and cache it
  - hybrid: server provides rank/group hints; client refines

## 2b) Strategic overview mode (whole-tree scanning)
This is a separate toggle/mode.

UX:
- Toggle/button: “Strategic” (enter/exit)
- Pan/zoom always available
- Very aggressive LOD:
  - far zoom: dots only, no labels
  - medium: surnames or initials only (or labels on hover)
  - close: allow full cards, but only for a small local neighborhood
- Provide fast filters to make scanning meaningful:
  - time window / era slider (e.g. 700–1100)
  - show/hide private people
  - show only “problem signals” overlays (see below)

Strategic “problem signals” (overlays):
- **Gaps**: people with missing parents/spouse/children in eras where you expect continuity
- **Duplicates**: candidates where name+date ranges suggest the same person in two places
  - (this can be a hint, not an auto-merge feature)

Backend implications:
- Needs an endpoint that can return a very large subgraph (potentially the whole tree)
  - but with minimal payload per node (so it can stream/load progressively)
- Consider a 2-stage fetch:
  1) strategic nodes+edges (minimal fields)
  2) on-demand person details only for what’s selected/zoomed

API shapes (suggestion):
- `GET /graph/strategic?max_people=4000&fields=min&include_private=0`
- `GET /graph/strategic/signals?era_start=700&era_end=1100`

Important: Strategic is *not* where we implement “every interaction.”
- It’s primarily for scanning, spotting anomalies, then drilling down into default exploration.

## 2c) Left sidebar (navigation + indexes)
Layout goal:
- A persistent left sidebar that lets you switch between a few “views” of the same underlying dataset.

Sidebar sections (buttons / tabs):

1) **Graph**
- The main interactive graph view (default + Strategic modes).

2) **People index (by surname)**
- A list of all people currently in the loaded dataset (or current graph scope), grouped by last name.
- Alphabetical grouping (A…Z). Within a surname group, sort by given name and/or birth year.
- Clicking a person focuses/selects them in the graph (and/or opens details).

Backend implications:
- Need a query that can list people for the current scope efficiently.
- Prefer returning a normalized “display name” and separate `surname` field.

API shape (suggestion):
- `GET /people?scope=current_graph|all&sort=surname,given,birth_year&surname_prefix=Ho`

3) **Events (search + filters)**
- A searchable list of events.
- Filters should include (at least):
  - event type (birth, baptism, marriage, death, burial, occupation, residence, etc.)
  - year range (e.g. births 1200–1400)
  - vocation/occupation keywords
  - location (place name / region)
  - person constraints (surname, descendants-of, ancestors-of)

Backend implications:
- Store event description/content as searchable fields.
- Postgres full-text search is ideal.

API shape (suggestion):
- `GET /events?query=<text>&type=birth&year_min=1200&year_max=1400&place=<id_or_text>&surname=hofland&descendants_of=<person_id>`

4) **Map (places + event-linked markers)**
Goal:
- Show locations on a map where events happened (and/or where people lived).
- All locations in the DB should have coordinates.
- Events often have a location attached; the map should be able to show markers for those.

Required map filtering examples:
- Only show people with surname “Hofland”
- Only show people/events in a certain era
- Only show descendants of a person (to visualize migration)

UX notes:
- Map should support selecting a subset of markers and using that as a filter for other views.
- Example: draw a rectangle/lasso or click markers → “use selection as filter” (applies to people/events/graph)

Backend implications:
- Places table should store coordinates.
- Need query endpoints that return markers efficiently with filters.

API shapes (suggestion):
- `GET /map/markers?type=events|people&surname=hofland&year_min=1500&year_max=1800&descendants_of=<person_id>`
- Optional for big datasets: `GET /map/markers?bbox=<minLon,minLat,maxLon,maxLat>&...`

Important: scope + consistency
- Decide whether sidebar lists show:
  - the whole database, or
  - the currently loaded graph scope.
- Both are useful; if both exist, the UI should make it explicit (scope toggle).

## 3) Pin a person + highlight route to current selection
UX:
- “Pin” a person (sticky anchor)
- Clicking other people highlights the path between selected and pinned
- Pin stays pinned while you pan/zoom and explore

Expanded: pin 2 people + relationship queries
- Allow **Pin A** and **Pin B** at the same time.
- When both pins exist, show relationship highlights between A and B.
- Offer a query toggle (applies when two pins exist):
  - **Route**: highlight the route(s) between A and B.
  - **Shared ancestor**: highlight their most relevant common ancestor(s) and the path(s) from A→ancestor and B→ancestor.
  - **Shared descendant**: highlight their common descendant(s) and the path(s) from A→descendant and B→descendant.

Notes:
- “Shared ancestor” can mean either:
  - **closest** shared ancestor (lowest common ancestor concept), or
  - **all** shared ancestors within a depth/era window.
- “Shared descendant” can be expensive if you ask for “all”. Prefer a depth limit and/or a max results cap.

Visuals:
- Pinned node gets a distinct outline/icon
- Path highlight draws a thick/bright overlay on nodes+edges
- Clear/unpin button

Pins “notepad” shortcut (anti-getting-lost during deep exploration):
- Provide a very fast way to drop temporary waypoints while exploring sprawling lines (e.g., long comital/noble lines with many forks).
- UX:
  - A quick action on a person card (e.g. right-click → **Pin**, or a small pin icon on the card)
  - Adds that person to a small toolbar list of pins (think “notepad” / waypoints)
  - Pin label auto-generated from the card: `Name + dates` (truncate safely)
  - Clicking a pin jumps/recenters to that person without “filling in the hole behind you” (no collapsing/removal of already-loaded graph)
  - One-click **Clear pins** to wipe the list, plus optional per-pin remove `×`

Backend:
- Uses `GET /graph/path` from section (1)
- Consider caching paths (or caching adjacency map client-side)

API shapes (suggestion):
- Extend path endpoint to support relationship queries:
  - `GET /graph/relationship?a=<person_id>&b=<person_id>&query=route|shared_ancestor|shared_descendant&mode=blood|any&max_results=10&max_depth=20`
  - returns a list of paths to highlight, plus “meeting” nodes (ancestor/descendant ids).

Edge cases:
- If no path exists (should be rare in a valid tree), show “no route found”
- Private/hidden nodes: either still compute path but hide labels, or exclude by policy

## 4) Click vs double-click interactions (node detail)
Single click:
- Select/focus the person (shows basic info in a side panel)
- Optional: if in “focus window” mode (below), this also recenters/redraws

Double click:
- Open a detail window/modal for that person
- Modal can fetch richer data on-demand

API shape (suggestion):
- `GET /person/<id>` minimal
- `GET /person/<id>/details` richer (events, notes, sources)

## 5) “Focus window” mode: click to redraw 4 generations around someone
This is the behavior you described:
- You’ve set “4 generations”
- You click someone at the edge
- The graph refreshes to show the 4 generations around *that* person

UX:
- This should feel like “jump focus” (recenter + new subgraph)
- Provide back/forward navigation (history stack)

Backend:
- `GET /graph/subgraph?center=<id>&generations=4...`

Important: This is distinct from map exploration.
- Map exploration: pan/zoom without relayout.
- Focus window: replace/refresh the current subgraph around a new center.

## 6) “Carve a path” mode: expand cul-de-sacs incrementally
Goal:
- Start from a seed person (or small focus window)
- Expand only where you choose, by clicking dead ends / “cul-de-sac” family placeholders

UX:
- Nodes that have undisplayed relatives show a clear affordance:
  - e.g. a small “+” badge with count: `+12`
  - or a special “family hub” marker labeled as a cul-de-sac
- Clicking expands just that area and merges new nodes into the existing view
- Keep the rest of the map stable (avoid global relayout if possible)

Backend representation:
- Need a way to know “this node has more neighbors not yet included.”
- If you model families as hubs, the cul-de-sac can literally be a family-id node.

Current implementation (viewer prototype):
- The `/demo/viewer` UI uses two targeted expand endpoints instead of a generic `POST /graph/expand`:
  - Expand up: `GET /graph/family/parents?family_id=<family>&child_id=<child>`
  - Expand down: `GET /graph/family/children?family_id=<family>&include_spouses=true`
- Family nodes can include `parents_total` and `children_total`; the viewer uses these counts to decide when to display expand indicators.

API shapes (suggestion):
- `POST /graph/expand` with body:
  - `{ seed_person_ids: [...], seed_family_ids: [...], already_have_person_ids: [...] }`
  - returns “new nodes + new edges only”

## 7) Search within notes + sort by event description/content
DB representation:
- Store notes as plain text.
- Use Postgres full-text search (tsvector) + optional trigram for fuzzy.
- Store event description/content in `event.description`.

## 8) Location data + map (separate from “graph as a map”)
DB representation:
- PostGIS point for places.
Frontend:
- Leaflet + OpenStreetMap tiles.

## 9) “Everything Gramps and more”
Reality check:
- Rebuilding the entire Gramps feature surface is a big project.
- A pragmatic approach is:
  1) get core browsing + your killer features working (path/search/map + graph explorer)
  2) add the long tail based on actual usage

## 10) Portrait images (mirror Gramps-linked media + crops)
Goal:
- Gramps Desktop allows a portrait image per person node, often with a saved crop.
- In Gramps, the image file is typically **linked from a local filesystem path**, not stored inside the Gramps database.
- For this app, we want to **mirror/copy** those images into app-managed storage so portraits reliably display in the web viewer.

What needs to be mirrored:
- Original image file (as-is) OR a normalized copy (recommended).
- A derived **portrait crop** (square or fixed aspect) based on Gramps crop settings.
- Optional: multiple sizes (thumbnail + medium + full) for performance.

Data we need from the export:
- For each person:
  - source image path (absolute or relative)
  - crop rectangle (x, y, w, h) and its coordinate system (pixels vs normalized 0..1)
  - original image width/height if crop is normalized

Storage / serving model (suggestion):
- Mirror into something like:
  - `api/static/media/original/<hash>.<ext>`
  - `api/static/media/portraits/<person_id>.jpg`
  - `api/static/media/portraits/<person_id>@2x.jpg` (optional)

Processing pipeline (suggestion):
- A one-time (or incremental) “sync portraits” step that:
  1) scans all people that have a portrait reference
  2) copies the source file into the mirror store (dedupe by content hash)
  3) generates a cropped portrait image based on the saved crop rectangle
  4) records a mapping table: `person_id → portrait_url + original_hash + crop_version`

Edge cases / expectations:
- Missing source file: show a placeholder portrait and list missing media in a report.
- Changed source file: detect via mtime/hash and re-mirror + regenerate crops.
- Crop out of bounds (bad data): clamp to image bounds.
- Privacy: for private/living people, optionally omit portrait serving in non-local deployments.

Frontend usage:
- Graph nodes show a tiny portrait thumbnail when available.
- Person detail modal shows a larger portrait (and potentially the original image).
