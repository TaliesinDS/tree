# Art Assets Checklist (Tree)

This document lists art assets to **acquire or create** for Tree (Gramps read-only genealogy viewer), with emphasis on the planned **Map** view.

Principles
- Prefer **original artwork** or assets with clear permissive licensing (**CC0**, **CC-BY**, **MIT/ISC** icon sets).
- Avoid “random web images” and unclear licensing.
- Prefer **SVG** for icons/markers (crisp at any zoom); keep a consistent stroke weight.
- Deliverables should be usable in a no-build static frontend (served from `api/static/...`).

Recommended formats
- Icons/markers: `SVG` (primary), plus optional `PNG` exports for fallbacks
- If using sprites: `PNG` spritesheet + a small manifest (`json`) describing coordinates
- Theme: provide light/dark variants only if needed; otherwise provide single-color shapes and tint via CSS.

---

## 1) Map markers (core)

### 1.1 Base marker shapes (place-centric)
These are the “default pins” for places (MapLibre/Leaflet style markers).

- [ ] `marker_place_settlement.svg` — classic pin, simple silhouette
- [ ] `marker_place_site.svg` — “site” marker (church/building/cemetery), distinct shape
- [ ] `marker_place_region.svg` — region/realm marker (flag/banner or rounded label plate)
- [ ] `marker_place_unknown.svg` — fallback marker (question / neutral)

Optional (nice-to-have)
- [ ] `marker_cluster.svg` — visual for clustered points (if clustering toggle is added)
- [ ] `marker_selected_ring.svg` — selection ring/halo overlay (SVG)
- [ ] `marker_hover_ring.svg` — hover ring/halo overlay (SVG)

### 1.2 Confidence / accuracy visuals
To communicate “exact vs approximate vs centroid”, without implying false precision.

- [ ] `confidence_exact.svg` — crisp halo/outline (or none)
- [ ] `confidence_approx.svg` — soft glow/blur ring
- [ ] `confidence_centroid.svg` — dotted/large-radius suggestion ring

(These can also be implemented purely with CSS, but having an SVG overlay is useful.)

---

## 2) Notable-event badges (overlay icons)

These are small “badges” that overlay a place marker (not separate pins).

Design constraints
- Must be readable at tiny size (16–20px)
- Use single-color silhouettes
- Avoid fine interior detail

### 2.1 Conflict & chivalry
- [ ] `badge_battle_survivor.svg` — crossed swords
- [ ] `badge_noble_slain_in_battle.svg` — sword-in-mound + helmet (simplified)
- [ ] `badge_knighting.svg` — hand holding sword (or simple pauldron)
- [ ] `badge_crusade_pilgrimage.svg` — scallop shell or Jerusalem cross
- [ ] `badge_captured_prisoner.svg` — shackles or barred window

### 2.2 Land & power
- [ ] `badge_castle_construction_ownership.svg` — battlement tower
- [ ] `badge_manor_estate_acquisition.svg` — key or manor house silhouette
- [ ] `badge_royal_grant_charter.svg` — scroll with wax seal
- [ ] `badge_banishment_exile.svg` — walking staff + bindle pointing away

### 2.3 Scholarly & religious
- [ ] `badge_monastic_entry.svg` — shears or monk hood
- [ ] `badge_founding_church.svg` — mitre or church spire
- [ ] `badge_excommunication.svg` — bell/book/candle (simplified)
- [ ] `badge_burial_great_noble.svg` — sarcophagus/recumbent effigy (very simplified)

### 2.4 “Peasant” exceptions (success symbols)
- [ ] `badge_guild_master.svg` — hammer + anvil (or compass)
- [ ] `badge_merchant_success.svg` — cog ship or balance scale

### 2.5 Generic/notable
- [ ] `badge_notable_star.svg` — star/asterisk badge
- [ ] `badge_nobility_crown.svg` — crown (for high nobility)

---

## 3) Map UI icons (controls)

If we don’t want to depend on an icon font, acquire these as SVGs.

Map actions
- [ ] `ui_map_layers.svg` — basemap selector
- [ ] `ui_map_filter.svg` — filter funnel
- [ ] `ui_map_pin.svg` — pin toggle
- [ ] `ui_map_route.svg` — route polyline icon
- [ ] `ui_map_download.svg` — download offline pack
- [ ] `ui_map_offline.svg` — offline indicator

Common UI
- [ ] `ui_search.svg`
- [ ] `ui_clear_x.svg`
- [ ] `ui_copy.svg`
- [ ] `ui_link_external.svg`
- [ ] `ui_info.svg`

---

## 4) Sidebar/tab icons (optional)

Only if we want icons in the left sidebar tabs.

- [ ] `tab_graph.svg`
- [ ] `tab_people.svg`
- [ ] `tab_families.svg`
- [ ] `tab_events.svg`
- [ ] `tab_places.svg`
- [ ] `tab_map.svg`

---

## 5) Backgrounds & textures (optional)

If the UI wants subtle “paper/map” texture (must be extremely subtle to avoid noise).

- [ ] `bg_paper_light.png` (or `.webp`) — seamless light paper
- [ ] `bg_paper_dark.png` (or `.webp`) — seamless dark paper

Notes
- Keep files small; prefer tiling textures.
- Avoid anything that looks like a scanned copyrighted map.

---

## 6) Source & licensing checklist (process)

For each acquired asset, record:
- [ ] Source URL
- [ ] Author/creator
- [ ] License (CC0 / CC-BY / MIT / purchased)
- [ ] Attribution text (if required)
- [ ] Proof of license (screenshot/PDF or stored note)
- [ ] Any restrictions (e.g., “no resale”, “no redistribution”, “editorial only”)

Suggested safe acquisition approaches
- Create the set yourself (simple silhouettes are fast)
- Commission a consistent SVG icon set (one style)
- Use an open-source icon library as a base style guide (then customize)
- If purchasing stock packs (Adobe/iStock/Shutterstock): ensure the license allows redistribution inside your app repo/distribution model

---

## 7) Where to put assets (suggested)

Proposed locations (adjust to taste):
- `api/static/relchart/img/ui/` — UI icons
- `api/static/relchart/img/map/` — markers + badges
- `api/static/relchart/img/bg/` — subtle textures

If you want, I can also add a simple `api/static/relchart/img/ATTRIBUTION.md` template so every asset has a paper trail.
