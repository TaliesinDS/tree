# Media Support — Implementation Plan

> **Status (Feb 2026): IMPLEMENTED.** All phases complete. The media system is fully
> operational: import pipeline extracts images and generates PNG thumbnails (with
> transparency), graph nodes show portrait thumbnails with aspect-ratio-aware
> rendering (slice for faces, meet for coat of arms), media browser overlay is
> available from the topbar, media tab in person detail panel with portrait picker,
> and media lightbox for full-size viewing. See copilot-instructions.md for current
> file locations and API endpoints.\n\n> **Notable implementation details vs plan:**\n> - Thumbnails are **PNG** (not JPEG) to preserve transparency for coat-of-arms images.\n> - Graph portraits use `xMidYMid meet` for tall images (CoA) and `xMidYMid slice` for face photos, based on `portrait_width`/`portrait_height` sent by the API.\n> - Portrait card width is `2.60\"` (vs plan's `0.55\"` portrait column + base width).\n> - No visible border around graph portrait images; only a rounded-corner clip mask.

## 1. Data Inventory (from `kortekaastest.gpkg`)

| Metric | Value |
|--------|-------|
| `<object>` definitions | 248 |
| `<objref>` references | 1,048 |
| Refs from `<person>` | 1,038 |
| Refs from `<event>` | 8 |
| Refs from `<placeobj>` | 2 |
| Image files in archive | 245 |
| Formats | JPEG, PNG, SVG→PNG |
| Size range | ~10 KB – ~815 KB |

### Gramps XML Structure

Each media item is an `<object>` with a `<file>` child:

```xml
<object handle="_f37b297fb8f308f567c5df7f3ba" id="O0000">
  <file src="Users/.../Wapen_Hofland.jpg"
        mime="image/jpeg"
        checksum="14c5e353db21261f77fea5aa6e00c8e1"
        description="Wapen_Hofland" />
</object>
```

References from people/events/places use `<objref>`:

```xml
<person handle="_abc123..." id="I0001">
  ...
  <objref hlink="_f37b297fb8f308f567c5df7f3ba"/>
</person>
```

Key observations:
- No `<attribute>` or `<noteref>` children on any media objects in this dataset.
- **31 crop rectangles** (`<region>`) are present on `<objref>` elements, linked to 31
  distinct person→media references. The region lives on the *reference* (not the
  `<object>` itself) and uses percentage coordinates (`corner1_x/y`, `corner2_x/y`,
  values 0–100). Example (person I0304 → media `_f38314add...`):
  ```xml
  <objref hlink="_f38314add7f386976c0886199bb">
    <region corner1_x="9" corner1_y="18" corner2_x="44" corner2_y="65"/>
  </objref>
  ```
  Multiple persons can reference the same media with different crop regions (e.g. a
  group photo where each person gets their own crop).
- Media files are embedded in the `.gpkg` tar archive under their original filesystem paths.
- 1,038 of 1,048 references are from **persons** — this is overwhelmingly person-linked media.

---

## 2. Surface Areas (Where Media Appears in the UI)

### 2A. Person Detail Panel — Media Tab
A tab already exists (currently shows "Media list coming soon."). Populate it with a
scrollable thumbnail grid of all media linked to the selected person.

### 2B. Person Detail Panel — Profile Picture / Avatar
The panel header already supports `portraitUrl`. The **default** portrait is the first
media object linked to the person (Gramps convention: first `<objref>`). However, the
user can override this:

- A **"Choose portrait"** button appears in the top-right corner of the Media tab.
- Clicking it enters "pick mode": each thumbnail gets a subtle selection overlay.
- Clicking a thumbnail confirms it as the portrait for this person (stored as a
  user preference via a new API endpoint, survives re-imports).
- While in pick mode, a **"No portrait"** popover button appears next to the
  "Choose portrait" button. Clicking it clears the portrait entirely.
- Exiting pick mode (click again or Escape) cancels without changes.
- The chosen portrait is used everywhere: detail panel avatar, peek tab, and
  graph node thumbnails.
- If no user override exists, falls back to the Gramps-default first media.

The portrait preference is stored per-person per-instance in a new
`person_portrait` table (or a column on `person_media`), so it persists
across sessions and re-imports.

### 2C. Graph Nodes — Thumbnail on Person Cards
Show a small portrait thumbnail on the person card in the Graphviz SVG. This is a
post-processing step in `render.js`: inject an `<image>` element into each person
node's `<g>` group, positioned in the top-right or left of the card.

### 2D. Topbar — Media Browser Button
A new button in the top bar (right side, next to *Options*) that opens a full-screen
or large overlay "Media Browser" panel. Contains:
- **Main area** (right): paginated/scrollable thumbnail grid of ALL media in the database.
- **Sidebar (left)**: filter controls at the top + metadata panel for the selected image below.
- **Metadata section** (in left sidebar, below filters): shows description, MIME type,
  dimensions, file size, checksum, and a list of all entities (people, events, places)
  that reference this media object, with clickable links to navigate to them.

---

## 3. Architecture Overview

### 3.1 Data Flow

```
.gpkg upload
    │
    ▼
┌─────────────────────────────┐
│  export_gramps_package.py   │  Parse <object> + <objref> from XML
│  (new: extract media JSONL  │  Extract image bytes from tar archive
│   + copy images to disk)    │  Write media.jsonl, person_media.jsonl,
│                             │  event_media.jsonl, place_media.jsonl
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  load_export_to_postgres.py │  Load media + link tables into Postgres
│  (new: media + link tables) │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  PostgreSQL (per-instance)  │  media, person_media, event_media,
│                             │  place_media tables
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  FastAPI routes/media.py    │  GET /media, GET /media/{id},
│                             │  GET /media/file/{id}
│  Static file serving from   │  Serve from api/media/<instance>/
│  instance-scoped directory  │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  Frontend                   │  Media tab, profile pic, graph nodes,
│                             │  media browser overlay
└─────────────────────────────┘
```

### 3.2 File Storage Layout

```
api/
  media/
    <instance_slug>/
      original/
        <handle>.<ext>          ← full-size image (deduped by handle)
      thumb/
        <handle>.jpg            ← 200×200 thumbnail (JPEG, generated)
```

Thumbnails are generated server-side during import to avoid shipping full images
for grid views. Original files are served on demand for the detail view / lightbox.

---

## 4. Database Schema Changes

Add to `sql/schema.sql`:

```sql
-- Media objects (from Gramps <object> elements)
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,                          -- Gramps handle
  gramps_id TEXT NULL,                          -- e.g. O0001
  mime TEXT NULL,                               -- image/jpeg, image/png, etc.
  description TEXT NULL,                        -- Gramps description field
  checksum TEXT NULL,                           -- MD5 from Gramps export
  original_path TEXT NULL,                      -- original src path from Gramps
  file_size INTEGER NULL,                       -- bytes (populated during import)
  width INTEGER NULL,                           -- pixels (populated during import)
  height INTEGER NULL,                          -- pixels (populated during import)
  is_private BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_gramps_id ON media(gramps_id);

-- Person ↔ Media link
CREATE TABLE IF NOT EXISTS person_media (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,        -- preserves Gramps ordering
  region_x1 SMALLINT NULL,                      -- crop rectangle corner1_x (0-100%)
  region_y1 SMALLINT NULL,                      -- crop rectangle corner1_y (0-100%)
  region_x2 SMALLINT NULL,                      -- crop rectangle corner2_x (0-100%)
  region_y2 SMALLINT NULL,                      -- crop rectangle corner2_y (0-100%)
  is_portrait BOOLEAN NOT NULL DEFAULT FALSE,    -- user-chosen portrait override
  PRIMARY KEY (person_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_person_media_media ON person_media(media_id);

-- Event ↔ Media link
CREATE TABLE IF NOT EXISTS event_media (
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, media_id)
);

-- Place ↔ Media link
CREATE TABLE IF NOT EXISTS place_media (
  place_id TEXT NOT NULL REFERENCES place(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (place_id, media_id)
);

-- Family ↔ Media link (future, none in current data)
CREATE TABLE IF NOT EXISTS family_media (
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, media_id)
);
```

Add `media` to the truncation order in `load_export_to_postgres.py` (before `person`).

---

## 5. Export Pipeline Changes (`export_gramps_package.py`)

### 5.1 Parse `<object>` Elements (Pass 1)

Add a new block alongside events/places/notes that collects media objects:

```python
media: dict[str, dict[str, Any]] = {}

# Inside the Pass 1 loop:
elif tag == "object":
    handle = elem.get("handle")
    gramps_id = elem.get("id")
    file_el = None
    for ch in elem:
        if _strip_ns(ch.tag) == "file":
            file_el = ch
            break
    if handle and file_el is not None:
        media[handle] = {
            "id": handle,
            "gramps_id": gramps_id,
            "mime": file_el.get("mime"),
            "description": file_el.get("description"),
            "checksum": file_el.get("checksum"),
            "original_path": file_el.get("src"),
            "is_private": _truthy_int(elem.get("priv")),
        }
```

### 5.2 Parse `<objref>` on Persons/Events/Places (Pass 2)

Collect link-table rows with ordering preserved:

```python
person_media: list[dict[str, Any]] = []
event_media: list[dict[str, Any]] = []
place_media: list[dict[str, Any]] = []

# Inside person parsing:
elif ctag == "objref" and ch.get("hlink"):
    # Check for <region> crop rectangle child
    region = None
    for rch in ch:
        if _strip_ns(rch.tag) == "region":
            region = {
                "x1": int(rch.get("corner1_x", 0)),
                "y1": int(rch.get("corner1_y", 0)),
                "x2": int(rch.get("corner2_x", 100)),
                "y2": int(rch.get("corner2_y", 100)),
            }
            break
    entry = {
        "person_id": handle,
        "media_id": ch.get("hlink"),
        "sort_order": len([x for x in person_media if x["person_id"] == handle]),
    }
    if region:
        entry.update(region)
    person_media.append(entry)

# Similarly for event and placeobj parsing (with region support).
```

### 5.3 Write New JSONL Files

```python
write_jsonl(out_dir / "media.jsonl", media.values())
write_jsonl(out_dir / "person_media.jsonl", person_media)
write_jsonl(out_dir / "event_media.jsonl", event_media)
write_jsonl(out_dir / "place_media.jsonl", place_media)
```

### 5.4 Extract Image Files from Archive

During import (in `import_service.py`), after JSONL export:
1. Re-open the `.gpkg` tar archive.
2. For each media object's `original_path`, locate the file in the tar.
3. Copy it to `api/media/<instance_slug>/original/<handle>.<ext>`.
4. Generate a 200×200 JPEG thumbnail → `api/media/<instance_slug>/thumb/<handle>.jpg`.
5. Optionally read image dimensions via PIL/Pillow and record `width`, `height`,
   `file_size` in the JSONL for database loading.

Thumbnail generation uses Pillow (`pip install Pillow`):
```python
from PIL import Image
img = Image.open(original_path)
img.thumbnail((200, 200))
img.save(thumb_path, "JPEG", quality=80)
```

Add `Pillow` to `api/requirements.txt`.

---

## 6. Loader Changes (`load_export_to_postgres.py`)

### 6.1 Load `media.jsonl`

Insert into the `media` table (between notes and people in load order):

```python
# Media
media_path = export_dir / "media.jsonl"
if media_path.exists():
    rows = list(_iter_jsonl(media_path))
    with conn.cursor() as cur:
        cur.executemany("""
            INSERT INTO media (id, gramps_id, mime, description, checksum,
                               original_path, file_size, width, height, is_private)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET
              gramps_id=EXCLUDED.gramps_id, mime=EXCLUDED.mime,
              description=EXCLUDED.description, checksum=EXCLUDED.checksum,
              original_path=EXCLUDED.original_path, file_size=EXCLUDED.file_size,
              width=EXCLUDED.width, height=EXCLUDED.height,
              is_private=EXCLUDED.is_private;
        """, [(r["id"], r.get("gramps_id"), r.get("mime"), r.get("description"),
               r.get("checksum"), r.get("original_path"), r.get("file_size"),
               r.get("width"), r.get("height"), bool(r.get("is_private", False)))
              for r in rows])
    counts["media"] = len(rows)
```

### 6.2 Load Link Tables

```python
# person_media — with crop region columns
load_link("person_media.jsonl", """
    INSERT INTO person_media (person_id, media_id, sort_order,
                              region_x1, region_y1, region_x2, region_y2)
    VALUES (%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (person_id, media_id) DO UPDATE SET
      sort_order = EXCLUDED.sort_order,
      region_x1 = EXCLUDED.region_x1,
      region_y1 = EXCLUDED.region_y1,
      region_x2 = EXCLUDED.region_x2,
      region_y2 = EXCLUDED.region_y2;
    -- Note: is_portrait is NOT overwritten by import (preserves user choice)
""", ["person_id", "media_id", "sort_order", "x1", "y1", "x2", "y2"])

# event_media, place_media — same pattern as other link tables
load_link("event_media.jsonl", """
    INSERT INTO event_media (event_id, media_id, sort_order)
    VALUES (%s,%s,%s)
    ON CONFLICT (event_id, media_id) DO NOTHING;
""", ["event_id", "media_id", "sort_order"])

load_link("place_media.jsonl", """
    INSERT INTO place_media (place_id, media_id, sort_order)
    VALUES (%s,%s,%s)
    ON CONFLICT (place_id, media_id) DO NOTHING;
""", ["place_id", "media_id", "sort_order"])
```

### 6.3 Truncation Order

Add to `_truncate_all`:
```python
tables = [
    "family_media",
    "place_media",
    "event_media",
    "person_media",
    # ... existing tables ...
    "media",       # after link tables, before person
    # ...
]
```

### 6.4 Backward Compatibility

Make `media.jsonl` optional in the `required` list (existing exports without media
should still load). Check `if media_path.exists():` before loading.

---

## 7. Backend API Endpoints (`api/routes/media.py`)

### 7.1 List All Media

```
GET /media?limit=100&offset=0&mime=image/jpeg&q=<search>&person_id=<id>
```

Returns paginated media listing with thumbnail URLs.

Response:
```json
{
  "offset": 0,
  "limit": 100,
  "total": 248,
  "results": [
    {
      "id": "_f37b297fb8...",
      "gramps_id": "O0000",
      "mime": "image/jpeg",
      "description": "Wapen_Hofland",
      "thumb_url": "/media/file/thumb/_f37b297fb8...jpg",
      "width": 800,
      "height": 600,
      "references": {
        "persons": 3,
        "events": 0,
        "places": 0
      }
    }
  ]
}
```

Query parameters for filtering:
- `q` — search description text (ILIKE)
- `mime` — filter by MIME type (exact or prefix like `image/`)
- `person_id` — filter to media linked to a specific person
- `has_refs` — `true`/`false` to filter media with/without references
- `sort` — `description_asc`, `description_desc`, `gramps_id_asc` (default: `gramps_id_asc`)

### 7.2 Single Media Detail

```
GET /media/{media_id}
```

Returns full metadata + all references:
```json
{
  "id": "_f37b297fb8...",
  "gramps_id": "O0000",
  "mime": "image/jpeg",
  "description": "Wapen_Hofland",
  "checksum": "14c5e353...",
  "original_path": "Users/.../Wapen_Hofland.jpg",
  "file_size": 98684,
  "width": 800,
  "height": 600,
  "thumb_url": "/media/file/thumb/_f37b297fb8...jpg",
  "original_url": "/media/file/original/_f37b297fb8...jpg",
  "references": {
    "persons": [
      { "id": "_abc...", "gramps_id": "I0001", "display_name": "Jan Hofland" }
    ],
    "events": [],
    "places": []
  }
}
```

### 7.3 Serve Media Files

```
GET /media/file/thumb/{handle}.jpg       → 200×200 thumbnail
GET /media/file/original/{handle}.{ext}  → full-size image
```

These are simple static file serves from `api/media/<instance_slug>/`.
Use `FileResponse` with proper `Content-Type` and caching headers.

Privacy: if the media object is `is_private` and privacy is enabled, return 403.
For media linked only to private persons, also return 403 (join check).

### 7.4 Person Media

```
GET /people/{person_id}/media
```

Returns ordered media for a person:
```json
{
  "person_id": "_abc...",
  "media": [
    {
      "id": "_f37b297fb8...",
      "gramps_id": "O0000",
      "description": "Wapen_Hofland",
      "mime": "image/jpeg",
      "thumb_url": "/media/file/thumb/_f37b297fb8...jpg",
      "original_url": "/media/file/original/_f37b297fb8...jpg",
      "sort_order": 0
    }
  ]
}
```

### 7.5 Portrait Override

```
PUT /people/{person_id}/portrait
```

Body: `{ "media_id": "_f37b..." }` or `{ "media_id": null }` (clear portrait).

Sets `is_portrait = true` on the chosen `person_media` row (and `false` on all
others for that person). When `media_id` is null, clears all `is_portrait` flags
so the default (first linked media) is used.

This is a user preference — it survives re-imports because the `is_portrait` flag
is not overwritten by the import pipeline (import uses `ON CONFLICT ... DO NOTHING`
for link tables, or a merge that preserves `is_portrait`).

Roles: user and admin can set portraits. Guests cannot (read-only).

### 7.6 Enrich Existing Endpoints

- **`GET /people/{person_id}/details`**: Add a `portrait_url` field to the `person`
  object. Uses the user-chosen portrait (`is_portrait = true` on `person_media`) if
  set, otherwise falls back to the first linked media (`sort_order = 0`).
  Populate the `media` array (currently empty `[]`).

- **`GET /graph/neighborhood`**: Add `portrait_url` to each person node in the
  payload so `render.js` can overlay portraits on graph cards. Same portrait
  resolution logic (user override → Gramps default).

---

## 8. Frontend Implementation

### File Organization (follows existing conventions)

| File | Purpose |
|------|---------|
| `js/features/media.js` | **Media tab** in person detail panel |
| `js/features/mediaBrowser.js` | **Media Browser** overlay (topbar button) |
| `js/api.js` | New fetch wrappers: `fetchMedia()`, `fetchMediaDetail()`, `fetchPersonMedia()` |
| `js/state.js` | New state keys for media browser |
| `js/app.js` | Wire `initMediaFeature()` and `initMediaBrowserFeature()` |
| `index.html` | Media Browser button in topbar, media browser overlay markup |
| `styles.css` | Styles for media grid, browser overlay, thumbnails |

### 8.1 Person Detail Panel — Media Tab (`js/features/media.js`)

Currently the `media` tab in `detailPanel.js` shows a placeholder. Replace with:

```
initMediaFeature({ selection })
```

When the Media tab is activated:
1. Call `GET /people/{person_id}/media`.
2. Render a thumbnail grid (CSS grid, 3 columns, gap: 8px).
3. Each thumbnail is clickable → opens a lightbox/enlarged view.
4. Show description below each thumbnail.

The first image is marked with a small "portrait" badge.

### 8.2 Person Detail Panel — Profile Picture

Already wired via `portrait_url` in `_setPanelHeader()`. Once the backend
populates `portrait_url` in the `/details` response, this works automatically.

### 8.3 Graph Nodes — Portrait Thumbnails (`js/chart/dot.js` + `js/chart/render.js`)

Portrait thumbnails are placed **to the left** of the existing card content. When a
person has a portrait, the card is **wider** to accommodate the image — the text area
stays the same width, and a fixed-size portrait column is prepended.

#### Phase 1: DOT generation (`dot.js`)

- Introduce a new constant for portrait dimensions:
  ```javascript
  const PORTRAIT_WIDTH_IN  = 0.55;  // fixed width added to left of card
  const PORTRAIT_HEIGHT_IN = PERSON_CARD_HEIGHT_IN; // same height as card
  ```
- When generating person nodes, check if `portrait_url` is present in the node data.
- If yes, set the node width to `PERSON_CARD_WIDTH_IN + PORTRAIT_WIDTH_IN`.
- If no, keep the existing `PERSON_CARD_WIDTH_IN`.
- The DOT label stays the same (text only) — the portrait image is injected in SVG
  post-processing.

#### Phase 2: SVG post-processing (`render.js`)

In `postProcessGraphvizSvg()`, for each person node with a portrait:
1. Look up `portrait_url` from `personMetaById`.
2. If present, inject an SVG `<image>` element positioned at the **left edge** of
   the card:
   ```javascript
   const PORTRAIT_PX_W = PORTRAIT_WIDTH_IN * 72; // convert inches to SVG points
   const PORTRAIT_PX_H = PERSON_CARD_HEIGHT_IN * 72;
   const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
   img.setAttribute('href', portraitUrl);
   img.setAttribute('x', cardX);
   img.setAttribute('y', cardY);
   img.setAttribute('width', PORTRAIT_PX_W);
   img.setAttribute('height', PORTRAIT_PX_H);
   img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
   nodeGroup.insertBefore(img, nodeGroup.firstChild); // behind text
   ```
3. The image uses `preserveAspectRatio="xMidYMid slice"` to fill the fixed
   rectangle (crop-to-fill, no distortion).
4. A subtle clip-path or rounded corner can be applied to match the card's border
   radius on the left side.
5. Shift existing text elements right by `PORTRAIT_PX_W` so they don't overlap
   the portrait area.
6. **Fixed dimensions**: the portrait area is always `PORTRAIT_WIDTH_IN` wide and
   `PERSON_CARD_HEIGHT_IN` tall, regardless of the source image's aspect ratio.
   `xMidYMid slice` handles the cropping.
7. If the media has a Gramps crop region, apply it via a `viewBox`-style clip
   on the `<image>` or by requesting a pre-cropped thumbnail URL from the server.

Fallback: no portrait → no extra width, no image element (card unchanged).

Privacy: private persons already get redacted names; their `portrait_url` will
be `null` from the backend, so no image is injected and the card stays narrow.

### 8.4 Media Browser (`js/features/mediaBrowser.js`)

#### Topbar Button

Add a "Media" button in the topbar's `.topRight` area, next to Options:

```html
<button id="mediaBrowserBtn" class="optionsBtn" type="button" title="Media browser">
  Media
</button>
```

#### Overlay Layout

The sidebar is on the **left**, split into filters (top) and metadata (bottom, scrollable).
The thumbnail grid fills the remaining space on the right.

```
┌──────────────────────────────────────────────────────────┐
│  Media Browser                                     [✕]   │
├────────────────┬─────────────────────────────────────────┤
│  Filters       │                                         │
│                │   Thumbnail Grid                        │
│  Search:       │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐     │
│  [___________] │   │     │ │     │ │     │ │     │     │
│                │   └─────┘ └─────┘ └─────┘ └─────┘     │
│  MIME type:    │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐     │
│  ☐ image/jpeg  │   │     │ │     │ │     │ │     │     │
│  ☐ image/png   │   └─────┘ └─────┘ └─────┘ └─────┘     │
│  ☐ Has refs    │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐     │
│                │   │     │ │     │ │     │ │     │     │
│  Sort:         │   └─────┘ └─────┘ └─────┘ └─────┘     │
│  [Description] │                                         │
│                │           ... more thumbnails ...       │
│ ─── Selected ──│                                         │
│                │                                         │
│  [  preview  ] │                                         │
│                │                                         │
│  Wapen_Hofland │                                         │
│  image/jpeg    │                                         │
│  98.7 KB       │                                         │
│  800 × 600     │                                         │
│  O0000         │                                         │
│                │                                         │
│  Referenced by │                                         │
│  ├ I0001 Jan H │                                         │
│  ├ I0023 Pie H │                                         │
│  └ I0045 Mar H │                                         │
│                │                                         │
└────────────────┴─────────────────────────────────────────┘
```

#### Filter Controls (left sidebar, top section)

| Filter | Type | Description |
|--------|------|-------------|
| Search | Text input | Searches `description` field (debounced, ILIKE) |
| MIME type | Checkboxes | Filter by `image/jpeg`, `image/png`, etc. (auto-detected from data) |
| Has references | Checkbox | Show only media that is linked to at least one entity |
| Person filter | Text input | Show only media linked to a specific person (autocomplete) |
| Sort | Dropdown | Description A→Z, Description Z→A, Gramps ID, File size |

#### Metadata Panel (left sidebar, below filters)

When a thumbnail is clicked/selected:
- Show enlarged preview (fit to available width).
- Description, MIME type, file size, dimensions, Gramps ID, checksum.
- "Referenced by" section: list of persons, events, places with clickable links.
  - Clicking a person: closes browser, navigates to that person in the graph.
  - Clicking an event: switches to Events tab and selects that event.

#### Interaction

- Thumbnail grid uses virtualized/lazy rendering for performance (248 items is
  manageable without virtualization, but design for growth).
- Infinite scroll or "Load more" pagination (100 items per page).
- Thumbnails have a subtle border + hover effect with the description as tooltip.
- Selected thumbnail has a highlighted border.
- Keyboard: arrow keys navigate grid, Enter opens lightbox.
- Close with Escape or close button.

---

## 9. Implementation Order

### Phase 1: Pipeline + Database (backend-only, no UI)

| Step | Task | Files Changed |
|------|------|---------------|
| 1.1 | Add `media`, `person_media`, `event_media`, `place_media`, `family_media` to `schema.sql` | `sql/schema.sql` |
| 1.2 | Parse `<object>` and `<objref>` in export script; write `media.jsonl`, `person_media.jsonl`, `event_media.jsonl`, `place_media.jsonl` | `export/export_gramps_package.py` |
| 1.3 | Load new JSONL files into Postgres | `export/load_export_to_postgres.py` |
| 1.4 | Extract image files from `.gpkg` archive during import; generate thumbnails | `api/import_service.py` |
| 1.5 | Add `Pillow` dependency | `api/requirements.txt` |
| 1.6 | Add truncation for new tables | `export/load_export_to_postgres.py` |
| 1.7 | Test: re-import `kortekaastest.gpkg`, verify media table has 248 rows, link tables populated, files on disk | manual / test script |

### Phase 2: API Endpoints

| Step | Task | Files Changed |
|------|------|---------------|
| 2.1 | Create `api/routes/media.py` with `GET /media`, `GET /media/{id}`, `GET /media/file/thumb/{handle}`, `GET /media/file/original/{handle}` | `api/routes/media.py` (new) |
| 2.2 | Register media router in `api/main.py` | `api/main.py` |
| 2.3 | Add `GET /people/{person_id}/media` endpoint | `api/routes/people.py` or `api/routes/media.py` |
| 2.4 | Add `PUT /people/{person_id}/portrait` endpoint for portrait override | `api/routes/media.py` |
| 2.5 | Enrich `GET /people/{person_id}/details` — add `portrait_url` to person object, populate `media` array | `api/routes/people.py` |
| 2.6 | Enrich `GET /graph/neighborhood` — add `portrait_url` to person nodes | `api/routes/graph.py` or `api/graph.py` |
| 2.7 | Privacy enforcement: skip private media, redact portrait_url for private persons | `api/routes/media.py`, `api/routes/people.py` |

### Phase 3: Frontend — Person Detail Panel

| Step | Task | Files Changed |
|------|------|---------------|
| 3.1 | Add `fetchPersonMedia()` to `api.js` | `js/api.js` |
| 3.2 | Create `js/features/media.js` — render media grid in the Media tab | `js/features/media.js` (new) |
| 3.3 | Wire media tab rendering in `detailPanel.js` (replace placeholder) | `js/features/detailPanel.js` |
| 3.4 | Portrait auto-display: backend now sends `portrait_url`, already wired | (no change needed) |
| 3.4b | "Choose portrait" button + "No portrait" popover in Media tab | `js/features/media.js` |
| 3.4c | `PUT /people/{person_id}/portrait` endpoint for saving portrait choice | `api/routes/media.py` |
| 3.5 | Add lightbox / enlarged image overlay for clicking thumbnails | `js/features/media.js` |
| 3.6 | Add CSS styles for media grid, lightbox | `styles.css` |

### Phase 4: Graph Node Portraits

| Step | Task | Files Changed |
|------|------|---------------|
| 4.1 | Add `PORTRAIT_WIDTH_IN` constant; widen person nodes with portraits in DOT | `js/chart/dot.js` |
| 4.2 | Pass `portrait_url` through `personMetaById` in render pipeline | `js/chart/render.js` |
| 4.3 | Inject `<image>` SVG element at left edge of widened cards; shift text right | `js/chart/render.js` |
| 4.4 | Use `preserveAspectRatio="xMidYMid slice"` for crop-to-fill in fixed rect | `js/chart/render.js` |
| 4.5 | Apply Gramps crop region to portrait thumbnail (if present) | `js/chart/render.js` |
| 4.6 | CSS for card left-side portrait (border-radius, subtle separator) | `styles.css` |
| 4.7 | Test with mixed portrait/no-portrait nodes; verify edge snapping still works | manual |

### Phase 5: Media Browser

| Step | Task | Files Changed |
|------|------|---------------|
| 5.1 | Add `fetchMedia()`, `fetchMediaDetail()` to `api.js` | `js/api.js` |
| 5.2 | Add media browser button to topbar in `index.html` | `index.html` |
| 5.3 | Add media browser overlay markup to `index.html` | `index.html` |
| 5.4 | Create `js/features/mediaBrowser.js` — full browser logic | `js/features/mediaBrowser.js` (new) |
| 5.5 | Add state keys for media browser to `state.js` | `js/state.js` |
| 5.6 | Wire `initMediaBrowserFeature()` in `app.js` | `js/app.js` |
| 5.7 | Add CSS for media browser overlay, grid, sidebar, metadata | `styles.css` |
| 5.8 | Implement filter controls (search, MIME, has-refs, person filter) | `js/features/mediaBrowser.js` |
| 5.9 | Implement metadata panel with clickable references | `js/features/mediaBrowser.js` |
| 5.10 | Navigation: clicking a person reference → closes browser, loads person in graph | `js/features/mediaBrowser.js` |
| 5.11 | Keyboard navigation (arrow keys, Escape to close) | `js/features/mediaBrowser.js` |

---

## 10. Privacy Considerations

| Rule | Implementation |
|------|----------------|
| `media.is_private = true` | Never serve file or metadata (403 from API) |
| Person is private/living | `portrait_url` is `null`; person-media endpoint returns empty array; media browser hides media that is *only* linked to private persons |
| Media linked to both public and private persons | Show the media, but only list public persons in the references |
| Privacy toggle OFF | Serve all media and references (same as other endpoints) |
| Guest role | Force privacy ON (like all other endpoints) |

---

## 11. Edge Cases & Future Work

- **Crop rectangles**: 31 `<objref>` elements have `<region>` crop coordinates
  (percentage-based, 0–100). These are exported into `person_media.region_x1/y1/x2/y2`.
  During import, Pillow uses the crop region to generate a person-specific cropped
  thumbnail when the region is present. The media browser and detail panel show the
  cropped version for the person context, and the original for the media-object context.

- **Non-image media**: MIME types other than `image/*` (PDFs, etc.) should show a
  file-type icon instead of a thumbnail. Future-proof the grid renderer.

- **Duplicate images**: Same file linked to multiple objects. The `checksum` column
  enables deduplication at the storage level if needed.

- **Large datasets**: For trees with thousands of media objects, the media browser
  needs server-side pagination (already designed) and possibly a more sophisticated
  virtual scroll.

- **Missing files**: If a media object exists in the XML but the file is missing from
  the archive, log a warning and show a "missing" placeholder.

- **Family media**: No `<objref>` on families in the current data, but the link table
  exists. Parse it if present in future exports.

- **Media notes/attributes**: None in the current data. The schema can be extended
  with `media_note` and `media_attribute` tables when needed.

- **Source citations on media**: Gramps supports linking sources to media. Out of
  scope for now but the pattern is identical to person_media.
