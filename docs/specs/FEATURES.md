# Feature mapping (what you want → backend capability)

This is a living mini-spec for the genealogy UI and the backend capabilities it implies.

See also: TECH_SPEC_GRAPH_VIEWER.md (feature → tech mapping and implementation notes).

Current implementation note (Jan 2026):
- The primary maintained frontend is **relchart v3** at `/demo/relationship` (Graphviz WASM + modular JS/CSS under `api/static/relchart/`).
- Older demos (e.g. `/demo/viewer`) are kept as reference/experiments and should not be treated as the direction going forward.

## Current status (relchart v3)

Implemented (working today):
- [x] Relationship chart render (Graphviz WASM) from `GET /graph/neighborhood?layout=family`
- [x] Map-like pan/zoom (drag + strong cursor-centered wheel zoom)
- [x] Viewport culling toggle (Cull) for huge graphs (hides off-screen nodes; edges shown only when endpoints are visible)
- [x] Incremental expand-in-place:
  - expand parents via `GET /graph/family/parents?family_id=<fid>&child_id=<pid>`
  - expand children via `GET /graph/family/children?family_id=<fid>&include_spouses=true`
- [x] Click person or family hub selects and updates the status bar (includes Gramps id when present)
- [x] People sidebar:
  - server-backed list (`GET /people`) with surname grouping
  - ignores surname particles for grouping (e.g. “van der Lee” under L)
  - search filter
  - “Expand” wide mode with right-aligned years and adjustable width
- [x] Families sidebar:
  - selecting a person auto-selects a relevant family when opening the Families tab
  - if the person is only visible as a child, falls back to selecting the parent family
- [x] Person detail panel:
  - loads `GET /people/{id}/details`
  - has a hidden “peek tab”; while loading it stays blank (no “L” from “Loading…”)- [x] Privacy toggle (Options menu):
  - "Privacy filter" checkbox (default ON, never persisted to localStorage)
  - when unchecked, all API calls include `?privacy=off` — reveals real names/dates for private people
  - amber "Privacy off" badge in top bar as visual indicator
  - toggling reloads the graph and invalidates cached sidebar data
- [x] In-browser import:
  - upload `.gpkg` / `.gramps` file via Options menu
  - triggers server-side import pipeline (`POST /import`)
  - polls `GET /import/status` with blocking overlay
  - auto-reloads graph on completion
  - max upload size: 200 MB
Partially implemented / placeholders:
- [~] Events and Places as standalone browsers (global search/filter/map) are planned; current work is mostly per-person detail rendering.

Performance note (Cull):
- The culling implementation is designed to remain responsive when zoomed in.
- It caches node bounds once after render and uses `svg.getScreenCTM()` to test visibility during pan/zoom without per-frame layout reads.

Not implemented yet (planned):
- [ ] Relationship-path highlight on the graph UI (API exists: `GET /relationship/path?from_id=...&to_id=...`)
- [ ] Pins / waypoints (toolbar pin list)
- [ ] Strategic (whole-tree) overview mode with LOD
- [ ] Portrait mirroring + heraldry cues (requires media ingestion + privacy)
- [ ] Reading mode (large notes/media/user notes)
- [ ] Save defaults (graph + map config) and set default “home person”

## Roadmap notes (relchart v3)
This section expands the running TODO list into small, actionable feature notes.

### Graph

**Card style improvements**
- Goal: make person cards more readable and more “map-like” (better contrast, spacing, hierarchy, and responsiveness across zoom levels).
- Likely work:
  - improve label typography (line-height, truncation rules, numeric alignment)
  - unify sex/role/edge markers so they’re consistent and minimal
  - optional LOD: zoomed-out shows surname-only or initials

**Person card selection indicator**
- Goal: selection should be unmistakable even in dense clusters.
- Likely work:
  - selected outline/glow + optionally a small corner badge
  - selection persists across expansions (no “lost selection” after rerender)
  - selection should be visible at low zoom (e.g. halo)

**Heraldry / portraits**
- Goal: show identity cues quickly (especially for nobility lines).
- Backend implication:
  - need media ingestion/mirroring from Gramps (see Portrait images section) and a stable URL per person.
  - likely a `person_media` table: `person_id, kind, url, is_private, crop, attribution`.
- Frontend implication:
  - show tiny portrait in card; fallback placeholders; obey privacy/redaction.

**Nobility ornament**
- Goal: optional ornamentation for titles/roles (crown/crest/border) without turning into a cluttered UI.
- Data source options:
  - explicit title events/attributes from Gramps
  - inferred heuristics (dangerous; best kept optional)

**Point-to-point edge finder and highlight**
- Goal: pick two people and highlight their relationship path on the current graph.
- UX:
  - “Pick A / Pick B” mode, then show highlighted nodes+edges; allow clearing.
- Backend:
  - current prototype: `GET /relationship/path?from_id=<id>&to_id=<id>&max_hops=12`
  - future: `GET /graph/path` (blood vs any) and optionally return the path edges for highlighting.
  - caching helps when repeatedly comparing.

**Default starter picker**
- Goal: avoid hardcoding a person id; provide a “start person” picker.
- UX:
  - use existing people search index; set the seed for the initial load.
- Backend:
  - `GET /people/search?q=` already exists; consider adding “recently used” client-side.

**Pin to sticky note action**
- Goal: “waypoint” workflow so deep exploration doesn’t lose context.
- UX:
  - pin icon on card → adds to a small sticky list; click pin to jump/center.
- Storage:
  - start with localStorage; later persist per-tree/per-user.

**Add written note on person**
- Goal: add short notes while exploring, without needing to switch back to Gramps immediately.
- Backend:
  - add a simple `user_note` table: `id, person_id, body, created_at, updated_at`.
  - optional: distinguish “research note” vs “todo”.

**Strategic view (show all)**
- Goal: whole-tree scanning mode with aggressive LOD.
- Backend:
  - a minimal bulk graph endpoint (`/graph/strategic`) that streams or pages nodes/edges.
- Frontend:
  - render as dots/lines at far zoom; expand details only near selection.

**Lineage-only ancestor view (patrilineal / matrilineal / direct ancestors)**
- Goal: pick a person and show a “clean spine” upward:
  - **Patrilineal**: father → father → father … (no siblings)
  - **Matrilineal**: mother → mother → mother … (no siblings)
  - **Direct ancestors**: both parents each generation, but still no siblings/extra spouses
- UX:
  - mode toggle + generation depth slider (e.g. 5, 10, 20, or “all until unknown”)
  - should be fast and stable (very small subgraph)
- Frontend utility available:
  - `api/static/relchart/js/chart/lineage.js` provides `traceAncestorLine(payload, rootId, { preferGender: 'M'|'F' })`
  - Returns `{ personIds, familyIds, personOrder, persons }` for highlighting
  - Use `getEdgesForLine()` to get edge list for SVG highlighting
- Backend (optional):
  - can be implemented as repeated parent lookups (cheap) or a recursive CTE with a “direction” filter
  - API shape idea: `GET /graph/lineage?center=<id>&mode=patrilineal|matrilineal|ancestors&max_depth=20`
  - return nodes+edges suitable for reuse in the main renderer

### Major UI elements

**Person detail panel**
- Goal: single-click opens a side panel with rich details (events, notes, relationships) without leaving the graph.
- Backend:
  - `GET /people/{id}` exists; likely add `GET /people/{id}/details` to include events, notes, families, media.

Small UX win (no backend required):
- In the user note section, allow choosing a per-person “map marker” (icon/color) stored in `localStorage` so notable people can stand out on the Map view.

**Event browser**
- Goal: search and filter events (timeline-like) and jump to people/places from events.
- Backend:
  - `GET /events` with filters: type, year range, place, text search.
  - potentially full-text search on event descriptions + notes.

**Family browser (maybe)**
- Goal: show “family objects” as first-class navigable entities: parents, children, marriage event(s).
- Backend:
  - `GET /families` list/search and `GET /families/{id}` details.
  - unify with existing family expand endpoints.

**Map**
- Goal: show place markers for event-linked locations and allow filtering/jumping back into the graph.
- Backend:
  - `GET /map/markers` (already described above) + place detail endpoints.

UI direction notes:
- The Map sidebar panel is primarily the Places browser/tree.
- Map settings/filters should live in the **topbar** (inline controls + popovers), not in the sidebar.
- Pins default ON.

**Places browser**
- Goal: browse/search places (with coords), see events per place, and see people associated.
- Backend:
  - `GET /places?query=` and `GET /places/{id}`.

**Data quality / debug reports**
- Goal: generate exportable lists of troublesome records (especially Places with missing `place_type`, missing `enclosed_by_id`, and/or missing coords) so they can be fixed in Gramps Desktop.
- Spec / notes: `DEBUG_DATA_QUALITY.md`

### UI trick: separate actions inside a `<summary>`
In the Places tree, an expandable row is a `<details>` with a `<summary>`.

- Clicking the `<summary>` toggles open/closed (native behavior)
- A child element inside the `<summary>` (e.g. the place name `<span>`) can run a different action (copy-to-clipboard) by calling `e.stopPropagation()` + `e.preventDefault()`

This allows “one click selects + toggles”, while “click the text copies” without needing extra buttons.

**Sticky note section**
- Goal: a persistent “scratchpad” for pins + notes.
- Subtasks:
  - persistent storage of notes (beyond localStorage)
  - export/print a TODO list back into Gramps desktop workflow (e.g. formatted text you can paste into a Gramps note)

### Experimental ideas

**Color person cards based on filter (e.g., color by country)**
- Goal: quick pattern spotting (migration, dynasties, regions).
- Data requirements:
  - need a consistent “country/region” tag derived from places (birth/death/residence) or user-assigned tags.
- UX:
  - treat as a visualization layer (toggleable), not part of the base identity color.

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
- current prototype: `GET /relationship/path?from_id=<person_id>&to_id=<person_id>&max_hops=12`
- future: `GET /graph/path?from=<person_id>&to=<person_id>&mode=blood|any`
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

Decision (current direction):
- Whole database scope is a first-class option (not hidden behind “Advanced”).
- Use guardrails (pin density, server-side limits, progressive rendering) rather than hiding the option.

## 2d) Reading mode (future)

Goal:
- A dedicated mode/tab for reading large notes, viewing media, and reviewing user notes without competing with the graph/map canvas.

Examples:
- Full-width reading layout (bigger font, comfortable line length)
- Media viewer (portraits, documents) with privacy-safe redactions
- User note review/triage (pinned research todos)

Notes:
- Not required for the Map topbar work; tracked here for later.

## 2e) Saved defaults (future)

Goal:
- Allow users to set their current configuration as the default startup configuration.

Scope:
- Graph defaults: depth/maxNodes and other graph tuning options.
- Map defaults: basemap, pins/routes toggles, scope, and related settings.
- Default “home person” (seed person on first load) should be part of this flow.

Storage:
- Start with localStorage.

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
- Uses the path endpoint from section (1)
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
- `GET /people/{id}` minimal
- `GET /people/{id}/details` richer (events, notes, sources)

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

Current implementation (relchart v3):
- The `/demo/relationship` UI uses two targeted expand endpoints instead of a generic `POST /graph/expand`:
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
