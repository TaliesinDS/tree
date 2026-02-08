# Plan: Make relchart v3 Responsive (Laptops + Tablets)

## Problem

The relchart v3 UI is hardcoded for a single viewport: a 2560x1440 desktop monitor.
When tested on a Samsung Galaxy Tab S8+, two categories of bugs appeared:

1. **Graph view**: pinch-to-zoom does not work (no multi-touch support)
2. **Map view**: base tiles render as disconnected squares in wrong positions; place pins do not appear

Additional issues (not yet tested, but expected from code inspection):
- Fixed sidebar width (340px) leaves almost no room for the chart on narrow screens
- Topbar controls overflow and clip on screens < ~1200px wide
- Person detail panel has fixed position/size optimized for large screens
- No `@media` queries exist anywhere in the CSS (zero breakpoints)
- Font sizes and spacing are tuned for high-DPI desktop, not tablet viewing distance

## Target devices

| Device class | Example | Viewport | Priority |
|-------------|---------|----------|----------|
| Desktop (full HD+) | 2560x1440, 1920x1080 | Current baseline | Must not regress |
| Laptop | 1366x768, 1440x900 | Common budget laptop | Must work |
| Tablet (landscape) | Galaxy Tab S8+ (1752x2800px, ~1138x1752 CSS px landscape) | Primary tablet target | Must work |
| Tablet (portrait) | Same, rotated | Not a target | Should work |
| Smartphone | Any | NOT a target | Explicitly excluded |

Minimum supported viewport width: **768px** (standard tablet portrait).

## Root Cause Analysis

### Issue 1: Graph pinch-zoom broken

**File**: `api/static/relchart/js/chart/panzoom.js`

The pan/zoom module uses Pointer Events (`pointerdown`/`pointermove`/`pointerup`) and `wheel` events. This is correct for mouse + single-finger drag, but:

- **No multi-touch handling**: the `down` handler captures a single pointer. When a second finger touches, there is no logic to track two active pointers, compute the distance delta, and translate that into viewBox scale changes.
- The `down` handler also skips events when `e.target.closest('g.node')` matches, which is correct for click-vs-drag disambiguation but doesn't affect pinch behavior (pinch issues are upstream of this check).
- `touch-action: none` is set on `.chart` (CSS line 2273), which correctly prevents browser-native scroll/zoom and hands control to JS — but the JS never handles multi-touch.

**Fix**: Add a multi-pointer tracker to `panzoom.js` that:
- Tracks active pointer IDs in a `Map`
- When exactly 2 pointers are active, computes inter-pointer distance
- On `pointermove`, derives a scale factor from distance change and applies it as viewBox zoom (same math as the `wheel` handler)
- Falls back to single-pointer drag when only 1 pointer is active (current behavior)

### Issue 2: Map tiles broken on tablet

**File**: `api/static/relchart/js/features/map.js`

The map uses Leaflet 1.9.4 loaded from CDN. Leaflet itself handles touch/pinch natively and works on tablets. The likely causes of the rendering bugs are:

1. **Container sizing**: Leaflet requires its container to have explicit dimensions when `L.map()` is called. The `.mapView` element uses `position: absolute; inset: 0` inside `.chart`. If the chart container itself has collapsed/incorrect dimensions at map init time (e.g., due to layout not settling on a touch device), Leaflet computes tile positions incorrectly.

2. **`touch-action: none` on parent**: the `.chart` container sets `touch-action: none`. This is correct for the graph (custom pan/zoom), but it also applies to the `.mapView` child. Leaflet expects to manage its own `touch-action` on its own container. The parent's `touch-action: none` may conflict with Leaflet's internal touch handling, causing tile position miscalculation.

3. **`invalidateSize` timing**: when switching to the map tab, `ensureMapInitialized()` calls `map.invalidateSize(false)` but does so before the CSS opacity transition completes (180ms). If the container's final layout hasn't committed yet, Leaflet caches wrong dimensions.

**Fix**:
- Set `touch-action: auto` specifically on `.mapView` so Leaflet can manage its own touch behavior
- Call `map.invalidateSize()` after a short delay (post-transition) or use a `ResizeObserver` on the map container
- Ensure the `.mapView` container has explicit dimensions at init time

### Issue 3: No responsive layout (no media queries)

**File**: `api/static/relchart/styles.css`

The layout is a rigid 2-column CSS grid:
`css
.shell {
  grid-template-columns: var(--sidebar-w) 1fr;
}
`

Where `--sidebar-w: 340px` is a fixed value. On a 768px-wide tablet, the chart area gets only ~428px — barely usable.

The topbar contains many controls in a single `flex-wrap: wrap` row, which works passably on wide screens but becomes a wall of tiny buttons on narrower viewports.

No `@media` queries exist. No feature queries (`@media (pointer: coarse)`).

## Detailed Fix Plan

### A. Add pinch-to-zoom to the graph (panzoom.js)

Location: `api/static/relchart/js/chart/panzoom.js`

Changes:
1. Add a `Map` to track active pointers: `const pointers = new Map()`
2. On `pointerdown`: store `{ id, x, y }` in the map
3. On `pointermove`: update the pointer's position
   - If `pointers.size === 1`: existing single-finger drag (no change)
   - If `pointers.size === 2`: compute pinch zoom
     - Get the two pointer entries
     - Compute current distance between them
     - Compare to previous distance (stored on first 2-pointer frame)
     - Derive scale factor: `newDist / oldDist`
     - Compute midpoint in SVG coords (using `getScreenCTM().inverse()`)
     - Apply zoom centered on midpoint (same formula as wheel handler)
     - Store current distance as "old" for next frame
4. On `pointerup` / `pointercancel`: remove pointer from map
   - If dropping from 2 to 1 pointer: reset drag origin to remaining pointer position (prevents "jump")

### B. Fix map rendering on tablets

Location: `api/static/relchart/js/features/map.js` + `styles.css`

Changes:
1. **CSS**: override `touch-action` on the map container:
   `css
   .mapView { touch-action: auto; }
   `
   This lets Leaflet manage its own touch gestures without the parent's `none` interfering.

2. **JS**: improve `invalidateSize` timing in `onEnterMapTab()`:
   - Wait for the opacity transition to finish (use `transitionend` event on `.mapView` or a 200ms `setTimeout`)
   - Then call `map.invalidateSize(true)`

3. **JS**: add a `ResizeObserver` on `.mapView` to call `map.invalidateSize()` whenever the container resizes (handles layout shifts from sidebar collapse, window resize, orientation change).

4. **Pins**: verify pin rendering works after the above fixes. The pin issue is likely a side effect of the tile position bug (if the map thinks it's at a different position/zoom, circleMarkers render off-screen).

### C. Add responsive breakpoints (styles.css)

Location: `api/static/relchart/styles.css`

Design approach: **mobile-last** (keep current desktop layout as default, add `max-width` breakpoints for smaller screens).

#### Breakpoint 1: Laptop (max-width: 1200px)

`css
@media (max-width: 1200px) {
  :root {
    --sidebar-w: 280px;
  }
}
`

- Narrow the sidebar slightly
- Reduce topbar padding

#### Breakpoint 2: Tablet landscape (max-width: 1024px)

`css
@media (max-width: 1024px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
  .sidebar {
    /* Collapse to a horizontal strip at top or a togglable drawer */
  }
}
`

Two options for sidebar on tablet:
- **Option A: Collapsible drawer** (recommended) — sidebar slides in from the left as an overlay when a hamburger button is tapped. Chart gets 100% width.
- **Option B: Bottom sheet** — sidebar becomes a bottom sheet. Less conventional for this type of app.

Recommend Option A (drawer).

#### Breakpoint 3: Tablet portrait (max-width: 768px)

- Same drawer behavior
- Person detail panel becomes a full-width bottom sheet instead of a floating card
- Topbar controls group into a compact layout or overflow into a dropdown

### D. Touch-friendly sizing (pointer: coarse)

Location: `api/static/relchart/styles.css`

For devices with coarse pointers (touch screens), increase tap target sizes:

`css
@media (pointer: coarse) {
  .miniToggle, .miniSelect, .miniNumber, .miniText {
    min-height: 44px;  /* Apple HIG minimum */
    font-size: 14px;
  }
  .tabbtn {
    padding: 12px 14px;
    font-size: 18px;
  }
  .peopleItem {
    padding: 8px 10px;
    min-height: 44px;
  }
}
`

### E. Sidebar drawer (tablet mode)

New elements needed:
- A hamburger/menu button in the topbar (visible only on narrow viewports)
- An overlay backdrop when the drawer is open
- CSS transitions for slide-in/out

Implementation:
- Add a `<button id="sidebarToggle">` to the topbar in `index.html`
- In CSS: hide it by default, show at breakpoint
- JS: toggle a `data-sidebar-open` attribute on `.shell`; use CSS to animate
- New feature module: `api/static/relchart/js/features/sidebar.js` with `initSidebarFeature()`

### F. Person detail panel responsiveness

Location: `api/static/relchart/styles.css` + `api/static/relchart/js/features/detailPanel.js`

Current issues:
- Fixed `width: 520px`, `height: 620px` — overflows on small screens
- Fixed `left: 48px`, `top: 72px` — positioned for desktop
- Drag-to-reposition works via pointer events but can drag the panel off-screen on small viewports

Changes:
- Add `max-width: calc(100vw - 24px)` and `max-height: calc(100vh - 24px)` to keep it in viewport
- At the tablet breakpoint, switch to a bottom sheet (full width, anchored to bottom)
- Clamp drag position to viewport bounds

### G. Topbar overflow handling

Location: `api/static/relchart/styles.css` + possibly `index.html`

Current: all controls are in a single `flex-wrap: wrap` row. On narrow screens this wraps into multiple rows and pushes the chart down.

Options:
- **Overflow menu**: at the breakpoint, collapse less-used controls (Max nodes, Depth, Cull) into an overflow dropdown, keeping only Person ID + Load + Fit visible
- **Scrollable topbar**: allow horizontal scroll on the topbar row (`overflow-x: auto`)

Recommend: overflow menu approach for cleaner UX. This can be done with a `<details>` element (matching existing options pattern).

## Files to modify

| File | Changes |
|------|---------|
| `api/static/relchart/styles.css` | Add breakpoints, touch targets, drawer styles, detail panel clamps |
| `api/static/relchart/index.html` | Add sidebar toggle button, possibly topbar overflow container |
| `api/static/relchart/js/chart/panzoom.js` | Add multi-pointer pinch-to-zoom |
| `api/static/relchart/js/features/map.js` | Fix invalidateSize timing, add ResizeObserver |
| `api/static/relchart/js/features/sidebar.js` | NEW: drawer toggle logic |
| `api/static/relchart/js/features/detailPanel.js` | Clamp position to viewport, bottom-sheet mode |
| `api/static/relchart/js/app.js` | Wire `initSidebarFeature()` (wiring only) |
| `api/static/relchart/js/state.js` | Add sidebar toggle element ref |

## Implementation order

1. **Pinch-to-zoom** (panzoom.js) — standalone fix, no CSS changes, immediately testable
2. **Map tile fix** (map.js + CSS touch-action) — standalone, immediately testable
3. **Responsive breakpoints** (CSS) — the big layout rework
4. **Sidebar drawer** (HTML + CSS + JS) — enables tablet layout
5. **Detail panel clamp** (CSS + JS) — prevents overflow on small screens
6. **Touch target sizing** (CSS) — polish pass
7. **Topbar overflow** (HTML + CSS) — polish pass

## Testing

### Devices to test on
- Desktop 2560x1440 (must not regress)
- Desktop 1920x1080
- Chrome DevTools device emulation: iPad (1024x768), Galaxy Tab S8+ (1138x1752)
- Physical Samsung Galaxy Tab S8+ (the device that surfaced the bugs)

### Test cases
- Graph: scroll wheel zoom works (desktop)
- Graph: pinch-to-zoom works (tablet)
- Graph: single-finger drag works (tablet)
- Graph: tap on person card opens detail panel (tablet)
- Map: base tiles render correctly (tablet)
- Map: pinch-to-zoom works on map (tablet, Leaflet native)
- Map: place pins appear when enabled (tablet)
- Map: switching basemap works
- Sidebar: visible on desktop, drawer on tablet
- Detail panel: stays within viewport bounds on all devices
- Topbar: all controls reachable on all devices
- Tab switching: works on all devices
- Orientation change (tablet): layout adjusts without broken map tiles

## Decisions to confirm

- Sidebar collapse strategy: drawer (recommended) vs bottom sheet
- Tablet portrait support: should the sidebar be accessible in portrait? (recommended: yes, via drawer)
- Topbar overflow: collapse to dropdown vs scrollable row
