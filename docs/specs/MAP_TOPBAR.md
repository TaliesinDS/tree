# Map Tab Topbar (relchart v3)

Date: 2026-01-20

Status: **Implemented (2026-01-20)**

## Summary

The current topbar is graph-load oriented (Person ID / Depth / Max nodes / Load / Fit / Reset). When the user switches to the **Map** tab, the topbar should switch to a **Map-specific control strip** that exposes basemap, pins, and route options described in:

- [docs/specs/MAP.md](MAP.md)
- [docs/specs/FEATURES.md](FEATURES.md)

The existing top-right cluster (Status + Options) remains globally useful and should stay unchanged.

Constraints / decisions from current direction:

- The app brand already exists in the sidebar header, so the topbar **does not need a brand section**.
- All tabs besides Map keep showing the **graph viewport** (there are no “other tab view modes”).
- The sidebar Map tab is primarily for the Places browser/tree; extra map filters/settings should live in **topbar popovers**, not in the sidebar.

## Goals

- Make Map tab feel “first-class” (the topbar does real work there).
- Keep controls discoverable and fast to use while exploring.
- Avoid clutter: show the most important toggles inline, tuck advanced knobs behind small popovers.
- Persist settings (localStorage) so users don’t constantly reconfigure.

## Non-goals

- Turn-by-turn routing (road-aware routes).
- Editing place coordinates.
- Large/complex download manager UI (offline packs can be a later iteration).

## UX Principles

- **Tab-aware controls**: Topbar “controls” area changes based on active sidebar tab.
- **Single source of truth for scope**: Scope (“selected person / graph-visible / whole DB”) should feed both pins and routes.
- **Safe defaults**:
  - Basemap defaults to a no-API-key topo.
  - Pins default ON.
  - Routes default Off.
- **Clear state**: Buttons should show whether a feature is active (and optionally a count).

## Topbar Structure

The topbar can be treated as two zones:

- Controls (left/middle)
- TopRight (right): Status + Options

Proposal: keep TopRight unchanged, and make the left/middle “Controls” area a **tab-aware container**:

- `graph` tab: existing graph controls
- `map` tab: new map controls (below)

All non-Map tabs continue to show the Graph view in the main viewport.

## Map Controls Row (recommended)

Left → right ordering (most common tasks first):

### 1) Basemap

Inline control:

- `Basemap: [Topo ▾]`

Options (no keys by default):

- Topo (OSM raster)
- Aerial (NASA GIBS)
- (Optional) Esri World Imagery (with clear disclaimer/terms)

Notes:

- Keep the in-map attribution element visible (already present as `#mapAttribution`).
- Also show a compact label in the topbar when switching (e.g., `Tiles: OSM` / `Tiles: NASA`).

### 2) Pins

One compact button that opens a popover:

- `Pins ▾` with an active indicator (e.g., `Pins` highlighted when enabled)

Popover contents (initial MVP subset first):

MVP:
- `[x] Show place pins` (default ON)
- `Pin density: [Auto ▾]` (Auto / Low / High) or `Max pins: [ 2000 ]`

Later (from MAP.md):
- `[ ] Cluster markers (performance mode)`
- `[ ] Collapse identical coords`
- `[ ] Region label banners` (for `region+centroid` semantics)

Badge/feedback:

- If enabled, show count in the label when cheap to compute (e.g., `Pins (142)`)

### 3) Scope (shared)

Single selector that drives “what data is shown” for pins *and* routes:

- `Scope: [Selected person ▾]`

Options:

- Selected person
- Current graph (neighborhood payload)
- Whole database

Notes:

- Scope should default to **Selected person**.
- Whole database scope is not hidden behind an “advanced” toggle (but may need sane guardrails like pin density limits).
- When in Map tab, selecting a person (via graph click, people list, or place-events popover) updates the Map scope input if scope is “Selected person”.

### 4) Routes

Inline toggle + mode selector:

- `Routes: [Off ⏻]` + `Mode: [Person timeline ▾]`

Mode options (aligning with MAP.md roadmap):

- Person timeline (selected person)
- Graph-visible timeline (later)
- Family combined (later)

Popover (advanced route styling):

- `[ ] Skip repeated places` (recommended default ON)
- `[ ] Direction arrows` (later)
- `[ ] Color by event type` (later)
- Year range filter (optional): `Years: [____] — [____]`

### 5) Quick Actions

Small buttons:

- `Fit pins` (zoom map to overlay bounds)
- `Clear overlays` (turn off pins + routes quickly)

Optional later:

- `Download offline maps…` (opens a panel/popover)

Also recommended (fits both Graph and Map):

- `Set current config as default` (persist current toggles/settings as the default startup config)
  - Map: basemap, pins toggles, scope, routes settings
  - Graph: depth/maxNodes, etc.
  - Related: “default home person” setting (seed person on first load)

## Interaction Rules

### Map-tab-only UI

When leaving Map tab:

- Close map popovers (Pins popover, Routes popover).
- Close place-related popovers (e.g., the place events panel).
- Keep persistent settings in state/localStorage, but stop rendering overlays.

When entering Map tab:

- Switch the main viewport to the Map view.
- Ensure Map-specific topbar controls are visible.

### Keyboard / Discoverability

- The existing tab hotkeys remain (`m` → map).
- Add optional shortcuts later:
  - `b` → cycle basemap
  - `r` → toggle routes
  - `i` → toggle pins

### Status messaging

When changing settings, write concise status updates:

- `Map: Basemap Topo`
- `Map: Pins on (142)`
- `Map: Routes on (12 segments)`

## Persistence (localStorage)

Store map settings under a stable key namespace, e.g.:

- `tree_relchart_map_basemap` (`topo` / `aerial` / …)
- `tree_relchart_map_pins_enabled` (bool)
- `tree_relchart_map_pins_mode` (`auto` / `low` / `high`)
- `tree_relchart_map_scope` (`selected_person` / `graph` / `db`)
- `tree_relchart_map_routes_enabled` (bool)
- `tree_relchart_map_routes_mode` (`person` / `graph` / `family`)

## Implementation Notes (relchart v3)

### HTML changes

- Add a `Map controls` container inside the topbar controls area.
- Hide/show Graph vs Map control containers based on the active tab.

### JS wiring

- Extend the existing tab switch logic (`window.relchartSetSidebarActiveTab`) to:
  - set `data-main-view` to `map` for Map tab
  - toggle topbar control containers
  - close Map-only popovers when leaving Map

Notes (as-built):

- Auto-fit on Map-tab entry should be “quiet” (avoid noisy `Map: nothing to fit` status).
- Leaving the Map tab should restore the last non-Map status message (avoid Map status “sticking”).
- Topbar popovers must render above the person detail panel (see below).

### Backend alignment

- Basemap switching is frontend-only.
- Pins/routes ultimately depend on event→place data and filters.
- The “event counts by place” endpoint can power:
  - pin badges
  - “places with events” filtering

Additional backend endpoint (as-built):

- `POST /graph/places` with `{ person_ids: [...], limit }` returns distinct public places referenced by non-private events for those people.
  - This exists specifically to make `Scope: Current graph` pins fast (avoid N calls to `/people/{id}/details`).

### Z-index / popover layering

The person detail panel is allowed to float above the topbar.

Because `position: sticky` creates a stacking context, topbar dropdown panels (Options, Pins, Routes) can render *under* the detail panel unless they escape that stacking context.

Current solution (as-built):

- When a topbar `<details>` menu opens, its panel is temporarily moved to `document.body` and positioned with `position: fixed` (a small “portal” helper).

## Rollout Plan

1) Topbar scaffold: add Map control strip, tab-aware toggling.
2) Basemap selector: Topo/Aerial.
3) Pins (default ON) + Fit pins.
4) Scope selector (Selected person / Graph).
5) Routes toggle + basic straight-line route overlay.

---

## Open Questions

- Should pin density limits change automatically by scope (Selected person vs Whole database)?
- Where should “Set current config as default” live: topbar, options menu, or both?

Future (not required now): a dedicated “Reading mode” tab/view for large notes/media/user notes.
