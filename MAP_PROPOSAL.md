# Map Proposal (relchart v3)

Current status (Jan 2026):
- A Map tab MVP is implemented in relchart v3 (`/demo/relationship`).
- The map renders in the **same main viewport** as the graph and cross-fades when switching between Graph and Map.
- Implementation: Leaflet (lazy-loaded from CDN) + OpenStreetMap raster tiles.
- Places list behavior:
  - clicking the **row/box** toggles expand/collapse (and can select/highlight), but does **not** move the map
  - clicking the **place name text** copies id + breadcrumb and centers/marks the map (when coords exist)

Goal: add a **Map** view to Tree (read-only Gramps viewer) that supports:
- **Topo + Aerial basemaps**
- **Pins** (all places/events, or selected subsets)
- **Straight-line routes** (migrations between event locations)
- **No required API accounts** for end users
- **Offline as optional**: online works by default; offline packs can be downloaded/installed.

Non-goals (initially):
- Turn-by-turn routing / road-aware routes
- Editing place coordinates
- Uploading tiles to third-party services

---

## 1) Recommended approach

### Map engine: **MapLibre GL JS**
Reasons:
- Works well with both raster and vector tiles
- Handles many markers + lines efficiently
- Has an emerging ecosystem for **single-file tile archives** (PMTiles)
- Clean path to **offline** (serve local PMTiles/tiles from the FastAPI server)

Fallback option: Leaflet is simpler for MVP, but MapLibre is a better fit long-term if we want many markers, styling, and smooth route overlays.

---

## 2) Basemap strategy (no API keys)

We want a default that “just works” for users, without accounts.

### 2.1 Online basemaps (default)
Provide two built-in basemaps with **no API key**:

**Topo (default online)**
- OpenStreetMap raster tiles (or another public raster source)
- Pros: ubiquitous, no key
- Cons: public tile servers have usage policies; heavy usage should be discouraged

**Aerial (default online)**
Two practical no-key options:
- **NASA GIBS** (global imagery layers; no key)
  - Pros: no key, reliable public program
  - Cons: not “Google-like” street-level aerial everywhere
- **Esri World Imagery** (no key, but subject to Esri terms)
  - Pros: high quality
  - Cons: licensing/terms must be respected; offline use is typically not allowed

Recommendation:
- Default aerial = **NASA GIBS** for “no account + safer policy posture”.
- Optionally add Esri as a configurable setting with a clear disclaimer.

### 2.2 Offline basemaps (optional)
Offline means: the viewer can show maps without internet.

For offline use we only need a **basic, low-detail topo** fallback (think “gas station atlas” level):
- country/region outlines
- major roads/rivers optionally
- enough context to place pins and see approximate distances/routes

Offline **aerial** is explicitly *not required*.

Key requirement: **no user accounts**. The offline pack should be either:
- bundled by the project, or
- downloaded from a project-controlled URL (e.g. GitHub Releases), or
- generated locally via scripts.

Two viable offline packaging formats:

**Option A (recommended): PMTiles**
- Single-file archive of tiles served over HTTP range requests
- Works well with MapLibre via a PMTiles integration
- Good distribution story: “download one file, drop it into a folder”

**Option B: MBTiles (SQLite)**
- Very common in offline mapping
- Requires a small tile-serving endpoint in FastAPI (`/tiles/{z}/{x}/{y}.png`)
- Also a good “drop-in file” format

**Option C (ultra-minimal, very small): single-image fallback**
- Ship a single offline raster image + bounds (or a tiny set of very-low-zoom tiles)
- Pros: can be extremely small and trivial to distribute
- Cons: not slippy/pretty; limited zoom

Recommendation for “basic offline that just exists”:
- Start with **very-low-zoom tiles** (e.g. zoom 0–6) for the relevant region(s), delivered as PMTiles/MBTiles.
- This keeps offline size manageable while still enabling pan/zoom and pin context.

Recommendation:
- Use **PMTiles** if we want a cleaner static-file experience.
- Use **MBTiles** if we want maximum tooling compatibility.

### 2.3 “Download maps” UX
Because global offline maps are huge, “download maps” should be explicit and scoped:

**User flow**
- Map tab shows online basemaps by default
- A section: “Offline maps”
  - If no offline packs installed: show a button/CTA: “Download offline pack (Netherlands, zoom 0–12)”
  - If packs exist: show toggles: “Offline Topo”, “Offline Aerial”

**Distribution**
- Provide prebuilt packs via GitHub Releases (no user accounts)
- Packs are region-scoped (e.g. Netherlands, Europe)

**Size expectations**
- Offline topo NL at zoom 0–12 can still be multiple GB depending on format/style.
- Make the UI show approximate size before downloading.

---

## 3) Data layers

### 3.0 Coordinate reality (important)
In practice, most place coordinates in this dataset are **approximate** (placed near a historical/semantic “center”), and only a small fraction are truly precise.
Also, many “subplaces” (e.g. a church used for burials) may share nearly the same coordinates as their parent place.

Additionally, some “places” are really **historical regions / houses / realms** (e.g. Saxony / Sachsen) where the pin represents a best-effort centroid for a time period.
Tree may not model chronological variants (Old Saxony vs New Saxony), so the same pin can be “right enough” for one person and very wrong for another.

Implications:
- The map must treat coordinates as **approximate hints**, not ground truth.
- Rendering should avoid implying false precision.
- The UI should gracefully handle **many places at identical/near-identical coordinates**.
- The UI should support an explicit notion of **location confidence / semantic kind** so users can tell “exact site” from “regional placeholder”.

### 3.0.1 Location confidence / semantic kind (recommended)
To handle medieval “house/realm” locations and other placeholders elegantly (without creating time-versioned regions), treat each place as having two optional attributes:

1) **kind** (what this marker represents)
- `site` (church, farm, cemetery, building)
- `settlement` (town/city/village)
- `region` (county/province/duchy/realm)
- `unknown`

2) **confidence / accuracy** (how close the coordinate is expected to be)
- `exact` (meters to a few km)
- `approx` (tens to hundreds of km)
- `centroid` (a representative point for a region; can be very far from an actual household)

How to get these values:
- MVP: infer from place name/type heuristics (e.g. if type contains “Duchy/Region” => `region+centroid`)
- Better: allow an optional per-place override (future table or a small JSON sidecar imported with the tree)

Marker styling (to communicate uncertainty):
- **Icon shape** by kind: pin for settlement, square/flag for region, cross for church/site
- **Halo / blur** by confidence: crisp for exact, soft-glow for approx
- **Uncertainty radius** (optional): draw a translucent circle (e.g. 5km/50km/200km) around the marker

This gives a clear visual language: “this is a regional placeholder” vs “this is a specific church”, even if both are just a single lat/lon.

### 3.1 Place-centric pins (recommended)
Places are the canonical geospatial entities in Tree: **events reference places**, and therefore share the same coordinates.
So the map should primarily render **place pins**, not separate event pins.

- “All places” pins based on `place.lat/lon`
- Optional marker styling:
  - different icon for “has children” vs leaf
  - event-count badges (e.g. “12 events here”)
- Filters operate on *events*, but affect the *place pins*:
  - event type (Birth/Death/Marriage/etc)
  - year range
  - person scope (selected person / current graph / whole DB)
  - when filters are active, show only places that have matching events (or visually de-emphasize the rest)

Marker popup content:
- normalized place name
- Gramps ID (`P####`) + internal handle
- breadcrumb (`Country > … > Place`)
- copy action
- “Pin / Unpin” (user pinning)
- event summary (counts by type; optionally list top N events with date/person)

Popup should also show:
- kind + confidence (e.g. “Region (centroid)”)
- a short disclaimer when not exact (e.g. “Approximate location”) to avoid misinterpretation

Marker aggregation rules (to handle shared coords):

Default rendering philosophy (per your preference):
- When zoomed out, a **dense forest of pins is good**: it communicates that “lots happened here”.
- Therefore, **do not cluster by default**. Clustering remains an optional toggle for performance.

Practical overlap handling (without spiderfy):
- Render **one marker per place** (place-centric), even if many are near each other.
- For places with identical/near-identical coordinates, apply a tiny **deterministic jitter** in screen-space (a few pixels), based on a stable hash of place id.
  - This makes stacked markers visible as a “thicket” without interactive fan-out.
  - The jitter radius shrinks with zoom, so at high zoom markers converge back onto the true point.
- Click behavior when jittered:
  - Clicking any of the jittered markers opens a popup/list scoped to that coordinate-group, so you can still pick the exact place/event.

Optional toggles (user-facing):
- [ ] Cluster markers (performance mode)
- [ ] Collapse identical coords (deduplicate by coordinate)

### 3.1.1 Region label banners (for centroid/realm locations)
For `region + centroid` style locations (Saxony/Sachsen, duchies, realms), a classic pin can be misleading.
Instead, render a **label banner** at the representative coordinate:

- A nice text label (e.g. **Saxony**) with a subtle background/outline for readability
- An optional small badge, e.g. `10 ppl` or `42 ev` depending on the active mode

This works well when:
- the coordinate is explicitly a placeholder/centroid
- many people/events are associated with a broad region

Counts definition (suggested):
- `ppl`: number of distinct people who have at least one matching event in that region (respecting filters)
- `ev`: number of matching events linked to places that roll up to that region (or directly to that region place)

Notes:
- The banner is a **summary UI**; clicking it should open a list/popup showing which underlying places/events contributed.
- Banners should be shown primarily at low zoom levels; at higher zoom, normal place pins and clusters take over.
- This plays nicely with the confidence model: region banners are effectively a first-class visualization for `centroid`.

Regional boundaries note:
- Regional/historical boundary polygons are explicitly **out of scope** for this project.
- **Labels + confidence cues** are the substitute.

### 3.2 Routes (straight-line)
Routes are computed from a sequence of events, but rendered as lines between the **places** for those events.

- Straight-line polylines connecting event *places* in chronological order
- Supported modes:
  1) **Per person**: selected person’s events → line sequence
  2) **Per family**: parents + children combined (later)
  3) **Graph-visible**: events for nodes currently in neighborhood payload (later)

Implementation note:
- If consecutive events are in the same place, skip zero-length segments.
- Optionally merge consecutive identical places to reduce visual noise.

Route styling:
- line color per event type transitions (optional)
- arrows for direction (optional)
- point labels on hover (date/type)

### 3.3 Notable event iconography (later iteration)
Some events are semantically “special” (e.g. battles) and some involve high nobility.
A later iteration can add iconography **without switching to separate event pins**:

- Keep **one marker per place**.
- Add **small overlay badges** on the place marker when that place has matching notable events.
  - Example badges: ⚔ for battle, 👑 for high nobility, ★ for “notable”.
- In the marker popup, show a “Notable here” section listing those events first (date + people involved).

How to drive it (options):
- MVP: heuristics based on event type/name keywords (e.g. type contains “Battle”).
- Better: a curated mapping table (event type/category → icon) or a small override JSON.

This preserves the place-centric model while still letting rare/important events visually pop out.

### 3.4 Per-person map marker (nice + low cost)
We already have the concept of **user notes** on a person in the detail panel.
A small, high-value enhancement is to let the user assign a **marker style** to that person from the same UI.

Examples:
- “Highlight person on map” (toggle)
- Choose an icon: ★ / 👑 / ⚔ / custom color


How it integrates with the place-centric map:
- When a place popup lists events/people, people with a chosen marker style get a small badge next to their name.
- Routes for a selected person can render endpoints with that person’s chosen icon/color.
- A “Show highlighted people” toggle can add subtle emphasis (e.g. halo) to places that contain events for highlighted people.

Storage (keep it simple):
- Persist locally in `localStorage` keyed by `person_id` (and tree identifier), so no backend/account is required.
- Optionally export/import this personalization as JSON.

---

## 4) Backend API plan (FastAPI)

### 4.1 New endpoints

**Places for map**
- `GET /map/places`
  - Returns only public places with coordinates
  - Response includes breadcrumb/enclosure chain for UI

Example shape:
```json
{
  "results": [
    {
      "id": "_...",
      "gramps_id": "P0123",
      "name": "Naaldwijk",
      "lat": 52.0,
      "lon": 4.2,
      "enclosure": [ {"id":"_...","name":"Netherlands"} ]
    }
  ]
}
```

**Events for map (drives filters, popups, and routes)**
- `GET /map/events?person_id=&types=&year_from=&year_to=`
  - Returns events with a resolved place that has coordinates
  - Must obey privacy rules already used elsewhere
  - Used to compute: (a) which places have matching events, (b) route sequences

**Routes**
- `GET /map/routes/person?person_id=...&types=...`
  - Returns ordered points (or segments) ready to draw

Note: routes can also be computed client-side once events are loaded; having a route endpoint makes filtering and ordering consistent.

### 4.2 Offline tiles serving (optional)
One of:

**PMTiles**
- Serve `.pmtiles` as static files (range requests)
- Provide an endpoint to list installed packs:
  - `GET /map/offline/packs` → metadata (name, type, bounds, min/max zoom)

**MBTiles**
- Add a tile endpoint:
  - `GET /map/tiles/{pack}/{z}/{x}/{y}.png`
- Requires reading MBTiles and returning tile bytes

---

## 5) Frontend plan (relchart v3, no-build ES modules)

Add a map module folder:
- `api/static/relchart/js/map/map.js`
- `api/static/relchart/js/map/layers.js`
- `api/static/relchart/js/map/pins.js`
- `api/static/relchart/js/map/routes.js`

Map tab behavior:
- `ensureMapInitialized()` called when opening Map tab
- Lazy-load map libraries (MapLibre JS + CSS) to avoid slowing initial chart load

UI controls (Map tab):
- Basemap: Topo / Aerial (Online)
- Offline section: list available offline packs + “Download” buttons
- Layers:
  - [ ] Places (all)
  - [ ] Event overlay (filtering/highlight of places)
  - [ ] My Pins
  - [ ] Region labels (banners)
- Routes:
  - [ ] Show route for selected person

Storage:
- Pins saved in `localStorage` (per tree) as list of place IDs/event IDs

---

## 6) Phased implementation

### Phase 0: Prep (1–2 sessions)
- Decide: MapLibre vs Leaflet (proposal recommends MapLibre)
- Decide: offline container format (PMTiles vs MBTiles)
- Add settings structure (client-side config + server-side optional)

### Phase 1: MVP map (online-only, no accounts)
- MapLibre map in Map tab
- Online topo + online aerial (NASA GIBS)
- Place pins (all places with coords)
- Click marker → popup + copy
- Optional: cluster markers

### Phase 2: Pins + routes (still online)
- “Pin this place/event” + pin list
- Straight-line routes for selected person’s events
- Route filtering by event type

### Phase 3: Offline packs (optional)
- Add offline pack discovery (`/map/offline/packs`)
- Implement one offline pack format:
  - Preferred: PMTiles
  - Alternative: MBTiles served by API
- Add UI: “Download offline pack” (from GitHub Releases) + “Use offline” toggle

### Phase 4: Better filtering + scale
- Server-side event queries by person/family/graph-visible
- Better clustering and viewport-based rendering
- “Fit to selection” and “Fit to route”

---

## 7) Risks / constraints
- Public tile servers (OSM) have usage policies; the app should avoid hammering them.
- Offline imagery is large; must be scoped by region/zoom.
- Licensing: imagery sources vary; prefer NASA GIBS for no-key aerial.
- Coordinate precision: most points are approximate; UI must avoid pretending street-level accuracy.

---

## 8) Open questions (decisions needed)
1) Preferred map engine for the codebase: **MapLibre** (recommended) or Leaflet?
2) Offline packaging: **PMTiles** (recommended) or MBTiles?
3) Default offline region packs: Netherlands-only first, or Europe?
