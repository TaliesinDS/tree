import { els, state, MAP_SETTINGS, _readBool, _readInt, _writeSetting } from '../state.js';
import { _isInsideDetailsOrPortal, _portalDetailsPanel, _unportalDetailsPanel } from './portal.js';

let _setStatus = null;
let _ensurePlacesLoaded = null;
let _selectPlaceGlobal = null;
let _resolveRelationsRootPersonId = null;
let _applyPlacesSelectionToDom = null;

let _placeSelectedListenerInstalled = false;

export function initMapFeature({
  setStatus,
  ensurePlacesLoaded,
  selectPlaceGlobal,
  applyPlacesSelectionToDom,
  resolveRelationsRootPersonId,
} = {}) {
  _setStatus = typeof setStatus === 'function' ? setStatus : null;
  _ensurePlacesLoaded = typeof ensurePlacesLoaded === 'function' ? ensurePlacesLoaded : null;
  _selectPlaceGlobal = typeof selectPlaceGlobal === 'function' ? selectPlaceGlobal : null;
  _applyPlacesSelectionToDom = typeof applyPlacesSelectionToDom === 'function' ? applyPlacesSelectionToDom : null;
  _resolveRelationsRootPersonId = typeof resolveRelationsRootPersonId === 'function' ? resolveRelationsRootPersonId : null;

  try { _initMapTopbarControls(); } catch (_) {}
  try { _wirePlaceSelectedCentering(); } catch (_) {}
}

function _wirePlaceSelectedCentering() {
  if (_placeSelectedListenerInstalled) return;
  _placeSelectedListenerInstalled = true;

  window.addEventListener('relchart:place-selected', (e) => {
    const detail = e?.detail || null;
    const pid = String(detail?.id || '').trim();
    if (!pid) return;

    // Always remember the last requested place selection.
    state.map.pendingPlaceId = pid;
    state.placesSelected = pid;

    // Only center when the map is actually visible.
    if (els.chart?.dataset?.mainView !== 'map') return;

    Promise.resolve(ensureMapInitialized()).then(() => {
      Promise.resolve(_ensurePlacesLoaded?.()).then(() => {
        const place = resolvePlaceForMap(detail);
        centerMapOnPlace(place);
        try { _applyPlacesSelectionToDom?.({ scroll: true }); } catch (_) {}
      });
    });
  });
}

function _setStatusSafe(msg, isError) {
  try {
    if (_setStatus) _setStatus(msg, isError);
  } catch (_) {}
}

function _closeMapPopovers() {
  try { if (els.mapPinsMenu) els.mapPinsMenu.open = false; } catch (_) {}
  try { if (els.mapRoutesMenu) els.mapRoutesMenu.open = false; } catch (_) {}
  try { if (els.mapPinsMenu) _unportalDetailsPanel(els.mapPinsMenu); } catch (_) {}
  try { if (els.mapRoutesMenu) _unportalDetailsPanel(els.mapRoutesMenu); } catch (_) {}
}

function _clampPinsMax(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 2000;
  return Math.max(50, Math.min(50_000, Math.trunc(x)));
}

function _applyMapUiToDom() {
  if (els.mapBasemap) els.mapBasemap.value = String(state.mapUi.basemap || 'topo');
  if (els.mapPinsEnabled) els.mapPinsEnabled.checked = !!state.mapUi.pinsEnabled;
  if (els.mapPinsMax) els.mapPinsMax.value = String(_clampPinsMax(state.mapUi.pinsMax));
  if (els.mapScope) els.mapScope.value = String(state.mapUi.scope || 'selected_person');
  if (els.mapRoutesMode) els.mapRoutesMode.value = String(state.mapUi.routesMode || 'person');
  if (els.mapRoutesSkipRepeated) els.mapRoutesSkipRepeated.checked = !!state.mapUi.routesSkipRepeated;

  if (els.mapPinsBtn) {
    const on = !!state.mapUi.pinsEnabled;
    els.mapPinsBtn.classList.toggle('active', on);
    const count = Number(state.mapUi.pinsCount || 0);
    els.mapPinsBtn.textContent = on && count > 0 ? `Pins (${count}) ▾` : 'Pins ▾';
  }

  if (els.mapRoutesToggle) {
    const on = !!state.mapUi.routesEnabled;
    const seg = Number(state.mapUi.routePoints || 0);
    els.mapRoutesToggle.classList.toggle('active', on);
    els.mapRoutesToggle.textContent = on
      ? (seg > 1 ? `Routes: On (${seg - 1})` : 'Routes: On')
      : 'Routes: Off';
  }
}

function _loadMapUiSettings() {
  const basemap = String(localStorage.getItem(MAP_SETTINGS.basemap) || '').trim().toLowerCase();
  state.mapUi.basemap = (basemap === 'aerial' || basemap === 'topo') ? basemap : 'topo';
  state.mapUi.pinsEnabled = _readBool(MAP_SETTINGS.pinsEnabled, true);
  state.mapUi.pinsMax = _clampPinsMax(_readInt(MAP_SETTINGS.pinsMax, 2000));

  const scope = String(localStorage.getItem(MAP_SETTINGS.scope) || '').trim().toLowerCase();
  state.mapUi.scope = (scope === 'graph' || scope === 'db' || scope === 'selected_person') ? scope : 'selected_person';

  state.mapUi.routesEnabled = _readBool(MAP_SETTINGS.routesEnabled, false);
  const mode = String(localStorage.getItem(MAP_SETTINGS.routesMode) || '').trim().toLowerCase();
  state.mapUi.routesMode = (mode === 'person' || mode === 'graph' || mode === 'family') ? mode : 'person';
  state.mapUi.routesSkipRepeated = _readBool(MAP_SETTINGS.routesSkipRepeated, true);
}

function _setMapAttribution(label) {
  if (!els.mapAttribution) return;
  const l = String(label || '').trim();
  if (!l) {
    els.mapAttribution.textContent = '';
    return;
  }
  els.mapAttribution.textContent = l;
}

function _nasaGibsDate() {
  // Use a small backoff to avoid requesting "future"/missing tiles.
  const d = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function _ensureBaseLayers() {
  if (!state.map.map || !window.L) return;
  if (state.map.baseLayers) return;
  const L = window.L;
  const aerialDate = _nasaGibsDate();

  state.map.baseLayers = {
    topo: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true,
    }),
    aerial: L.tileLayer(
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${aerialDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      {
        maxZoom: 9,
        crossOrigin: true,
      }
    ),
  };
}

function _applyBasemap() {
  if (!state.map.map || !window.L) return;
  _ensureBaseLayers();
  const kind = String(state.mapUi.basemap || 'topo').trim().toLowerCase();
  const map = state.map.map;
  const layers = state.map.baseLayers || {};
  const next = layers[kind] || layers.topo;
  if (!next) return;

  try {
    if (state.map.baseLayer && map.hasLayer(state.map.baseLayer)) {
      map.removeLayer(state.map.baseLayer);
    }
  } catch (_) {}

  try {
    next.addTo(map);
    state.map.baseLayer = next;
  } catch (_) {}

  if (kind === 'aerial') {
    _setMapAttribution('Map tiles © NASA GIBS');
  } else {
    _setMapAttribution('Map tiles © OpenStreetMap contributors');
  }
}

function _ensureOverlayLayers() {
  if (!state.map.map || !window.L) return;
  const L = window.L;
  if (!state.map.pinsLayer) state.map.pinsLayer = L.layerGroup();
  if (!state.map.routesLayer) state.map.routesLayer = L.layerGroup();
}

function _setMapOverlaysVisible(visible) {
  if (!state.map.map || !window.L) return;
  _ensureOverlayLayers();
  const map = state.map.map;
  const on = !!visible;
  const addOrRemove = (layer) => {
    if (!layer) return;
    try {
      const has = map.hasLayer(layer);
      if (on && !has) layer.addTo(map);
      if (!on && has) map.removeLayer(layer);
    } catch (_) {}
  };
  addOrRemove(state.map.pinsLayer);
  addOrRemove(state.map.routesLayer);
}

function _escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

async function _getPersonDetailsCached(personId) {
  const pid = String(personId || '').trim();
  if (!pid) return null;
  const cached = state.mapUi.personDetailsCache.get(pid) || null;
  if (cached && cached.events) return cached;

  // Reuse detail panel data if it matches.
  try {
    const ref = String(state.detailPanel?.lastPersonId || '').trim();
    if (ref === pid && state.detailPanel?.data?.events) {
      const data = { events: state.detailPanel.data.events };
      state.mapUi.personDetailsCache.set(pid, data);
      return data;
    }
  } catch (_) {}

  const r = await fetch(`/people/${encodeURIComponent(pid)}/details`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const out = { events: Array.isArray(data?.events) ? data.events : [] };
  state.mapUi.personDetailsCache.set(pid, out);
  return out;
}

function _placeHasCoords(p) {
  const lat = Number(p?.lat);
  const lon = Number(p?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function _placeLatLng(p) {
  const lat = Number(p?.lat);
  const lon = Number(p?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}

function _eventYearHint(ev) {
  const iso = String(ev?.date || '').trim();
  if (iso) {
    const m = iso.match(/^(\d{4})/);
    if (m) {
      const y = Number(m[1]);
      if (Number.isFinite(y)) return y;
    }
  }

  const txt = String(ev?.date_text || '').trim();
  if (txt) {
    const m = txt.match(/\b(\d{4})\b/);
    if (m) {
      const y = Number(m[1]);
      if (Number.isFinite(y)) return y;
    }
  }
  return null;
}

function _eventSortKey(ev) {
  const iso = String(ev?.date || '').trim();
  if (iso) {
    const d = Date.parse(iso);
    if (Number.isFinite(d)) return d;
  }
  const y = _eventYearHint(ev);
  if (typeof y === 'number' && Number.isFinite(y)) {
    // Middle of year heuristic.
    return Date.UTC(y, 5, 30);
  }
  return Number.POSITIVE_INFINITY;
}

function _resolveRootPersonIdForScope() {
  if (!_resolveRelationsRootPersonId) return null;
  try {
    return String(_resolveRelationsRootPersonId() || '').trim() || null;
  } catch (_) {
    return null;
  }
}

async function _computePlacesForScope() {
  const scope = String(state.mapUi.scope || 'selected_person').trim().toLowerCase();
  const maxPins = _clampPinsMax(state.mapUi.pinsMax);
  const byId = state.placeById || new Map();

  const takePlaces = (placeIds) => {
    const out = [];
    for (const pid of placeIds) {
      if (out.length >= maxPins) break;
      const p = byId.get(String(pid)) || null;
      if (!p || !_placeHasCoords(p)) continue;
      out.push(p);
    }
    return out;
  };

  if (scope === 'db') {
    const places = Array.isArray(state.places) ? state.places : [];
    const ids = [];
    for (const p of places) {
      const pid = String(p?.id || '').trim();
      if (!pid) continue;
      if (!_placeHasCoords(p)) continue;
      const count = Number(state.placeEventCountById?.get?.(pid) ?? 0);
      if (count <= 0) continue;
      ids.push(pid);
      if (ids.length >= maxPins) break;
    }
    return takePlaces(ids);
  }

  if (scope === 'graph') {
    const nodes = Array.isArray(state.payload?.nodes) ? state.payload.nodes : [];
    const people = nodes.filter(n => n?.type === 'person' && n?.id).map(n => String(n.id));
    const personLimit = Math.min(200, people.length);
    const selectedPeople = people.slice(0, personLimit);

    // Fast path: ask the backend for all places for these people in one query.
    // This avoids N separate /people/{id}/details calls (which is very slow on
    // medium-sized graphs).
    try {
      const r = await fetch('/graph/places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_ids: selectedPeople, limit: maxPins }),
      });
      if (r.ok) {
        const data = await r.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        return results.filter(_placeHasCoords).slice(0, maxPins);
      }
    } catch (_) {
      // Fall back below.
    }

    const placeIds = [];
    const seen = new Set();
    for (const pid of selectedPeople) {
      if (seen.size >= maxPins) break;
      try {
        const d = await _getPersonDetailsCached(pid);
        const events = Array.isArray(d?.events) ? d.events : [];
        for (const ev of events) {
          const plid = String(ev?.place?.id || '').trim();
          if (!plid || seen.has(plid)) continue;
          seen.add(plid);
          placeIds.push(plid);
          if (seen.size >= maxPins) break;
        }
      } catch (_) {}
    }

    return takePlaces(placeIds);
  }

  // selected_person
  const root = _resolveRootPersonIdForScope();
  if (!root) return [];
  const d = await _getPersonDetailsCached(root);
  const events = Array.isArray(d?.events) ? d.events : [];
  const seen = new Set();
  const placeIds = [];
  for (const ev of events) {
    const plid = String(ev?.place?.id || '').trim();
    if (!plid || seen.has(plid)) continue;
    seen.add(plid);
    placeIds.push(plid);
    if (placeIds.length >= maxPins) break;
  }
  return takePlaces(placeIds);
}

async function _computeRouteLatLngs() {
  if (!state.mapUi.routesEnabled) return [];
  const scope = String(state.mapUi.scope || 'selected_person').trim().toLowerCase();
  const mode = String(state.mapUi.routesMode || 'person').trim().toLowerCase();
  if (scope !== 'selected_person' || mode !== 'person') return [];

  const root = _resolveRootPersonIdForScope();
  if (!root) return [];

  const d = await _getPersonDetailsCached(root);
  const events = Array.isArray(d?.events) ? d.events : [];
  const byId = state.placeById || new Map();
  const ordered = events.slice().sort((a, b) => _eventSortKey(a) - _eventSortKey(b));

  const out = [];
  let lastPlaceId = null;
  for (const ev of ordered) {
    const plid = String(ev?.place?.id || '').trim();
    if (!plid) continue;
    if (state.mapUi.routesSkipRepeated && lastPlaceId && plid === lastPlaceId) continue;
    const p = byId.get(plid) || null;
    if (!p || !_placeHasCoords(p)) continue;
    const ll = _placeLatLng(p);
    if (!ll) continue;
    out.push(ll);
    lastPlaceId = plid;
  }
  return out;
}

async function _renderMapOverlaysNow() {
  if (!state.map.map || !window.L) return;
  if (els.chart?.dataset?.mainView !== 'map') return;
  if (_ensurePlacesLoaded) await _ensurePlacesLoaded();
  _ensureOverlayLayers();

  // Ensure overlay layers are mounted.
  _setMapOverlaysVisible(true);

  // Clear existing overlays.
  try { state.map.pinsLayer?.clearLayers?.(); } catch (_) {}
  try { state.map.routesLayer?.clearLayers?.(); } catch (_) {}

  state.mapUi.pinsCount = 0;
  state.mapUi.routePoints = 0;

  if (state.mapUi.pinsEnabled) {
    let places = [];
    try {
      places = await _computePlacesForScope();
    } catch (e) {
      _setStatusSafe(`Map: pins failed (${e?.message || e})`, true);
      places = [];
    }

    const L = window.L;
    for (const p of places) {
      const ll = _placeLatLng(p);
      if (!ll) continue;
      const pid = String(p?.id || '').trim();
      const label = String(p?.name || pid || '').trim();
      const count = Number(state.placeEventCountById?.get?.(pid) ?? 0);

      const marker = L.circleMarker(ll, {
        radius: 5,
        color: '#000000dc',
        weight: 2,
        opacity: 0.6,
        fillColor: '#d10000e5',
        fillOpacity: 0.6,
      });
      // Clicking a marker should behave like selecting the place anywhere else:
      // highlight it in the Places list, update status, and center it (Map tab).
      try {
        marker.on('click', () => {
          try {
            if (_selectPlaceGlobal) _selectPlaceGlobal(p, { emitMapEvent: true });
          } catch (_) {}
        });
      } catch (_) {}
      marker.bindPopup(`${_escapeHtml(label)}${count > 0 ? `<div style="opacity:0.75;font-size:12px">Events: ${count}</div>` : ''}`);
      marker.addTo(state.map.pinsLayer);
    }
    state.mapUi.pinsCount = places.length;
  }

  if (state.mapUi.routesEnabled) {
    const L = window.L;
    let latlngs = [];
    try {
      latlngs = await _computeRouteLatLngs();
    } catch (e) {
      _setStatusSafe(`Map: routes failed (${e?.message || e})`, true);
      latlngs = [];
    }
    if (latlngs.length >= 2) {
      L.polyline(latlngs, { color: '#7aa2ff', weight: 3, opacity: 0.8 }).addTo(state.map.routesLayer);
      state.mapUi.routePoints = latlngs.length;
    }
  }

  _applyMapUiToDom();

  // After a hard refresh it's easy to think pins "didn't render" when the map
  // is just centered somewhere else. When entering the Map tab with no specific
  // place selection pending, auto-fit once so markers are immediately visible.
  try {
    if (state.mapUi.autoFitPending) {
      state.mapUi.autoFitPending = false;
      if (state.mapUi.pinsEnabled && (state.mapUi.pinsCount || 0) > 0) {
        _fitMapToOverlays({ quiet: true });
      }
    }
  } catch (_) {}
}

function _scheduleMapOverlayRefresh() {
  try {
    if (state.mapUi.overlayRefreshTimer) clearTimeout(state.mapUi.overlayRefreshTimer);
  } catch (_) {}
  state.mapUi.overlayRefreshTimer = setTimeout(() => {
    state.mapUi.overlayRefreshTimer = null;
    Promise.resolve(_renderMapOverlaysNow()).catch(() => {});
  }, 80);
}

function _fitMapToOverlays({ quiet = false } = {}) {
  if (!state.map.map || !window.L) return;
  _ensureOverlayLayers();
  const map = state.map.map;
  const bounds = [];
  try {
    const b1 = state.map.pinsLayer?.getBounds?.();
    if (b1 && b1.isValid && b1.isValid()) bounds.push(b1);
  } catch (_) {}
  try {
    const b2 = state.map.routesLayer?.getBounds?.();
    if (b2 && b2.isValid && b2.isValid()) bounds.push(b2);
  } catch (_) {}
  if (!bounds.length) {
    if (!quiet) _setStatusSafe('Map: nothing to fit.', true);
    return;
  }
  const merged = bounds.reduce((acc, b) => (acc ? acc.extend(b) : b), null);
  try { map.fitBounds(merged, { padding: [30, 30], animate: true, duration: 0.25 }); } catch (_) {
    try { map.fitBounds(merged, { padding: [30, 30] }); } catch (_err2) {}
  }
}

function _initMapTopbarControls() {
  _loadMapUiSettings();
  _applyMapUiToDom();

  // Portal popover panels above the detail panel.
  try {
    if (els.mapPinsMenu) {
      els.mapPinsMenu.addEventListener('toggle', () => {
        if (els.mapPinsMenu.open) _portalDetailsPanel(els.mapPinsMenu, '.topbarPanel', { align: 'left' });
        else _unportalDetailsPanel(els.mapPinsMenu);
      });
    }
    if (els.mapRoutesMenu) {
      els.mapRoutesMenu.addEventListener('toggle', () => {
        if (els.mapRoutesMenu.open) _portalDetailsPanel(els.mapRoutesMenu, '.topbarPanel', { align: 'left' });
        else _unportalDetailsPanel(els.mapRoutesMenu);
      });
    }
  } catch (_) {}

  // Close the popovers when clicking outside.
  document.addEventListener('click', (e) => {
    const pinsOpen = !!(els.mapPinsMenu && els.mapPinsMenu.open);
    const routesOpen = !!(els.mapRoutesMenu && els.mapRoutesMenu.open);
    if (!pinsOpen && !routesOpen) return;
    const t = e?.target;
    if (t && (
      _isInsideDetailsOrPortal(els.mapPinsMenu, t)
      || _isInsideDetailsOrPortal(els.mapRoutesMenu, t)
    )) return;
    _closeMapPopovers();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _closeMapPopovers();
  });

  if (els.mapBasemap) {
    els.mapBasemap.addEventListener('change', () => {
      state.mapUi.basemap = String(els.mapBasemap.value || 'topo').trim().toLowerCase();
      _writeSetting(MAP_SETTINGS.basemap, state.mapUi.basemap);
      _applyBasemap();
      _setStatusSafe(`Map: Basemap ${state.mapUi.basemap === 'aerial' ? 'Aerial' : 'Topo'}`);
    });
  }

  if (els.mapPinsEnabled) {
    els.mapPinsEnabled.addEventListener('change', () => {
      state.mapUi.pinsEnabled = !!els.mapPinsEnabled.checked;
      _writeSetting(MAP_SETTINGS.pinsEnabled, state.mapUi.pinsEnabled ? '1' : '0');
      _setStatusSafe(state.mapUi.pinsEnabled ? 'Map: Pins on' : 'Map: Pins off');
      if (els.chart?.dataset?.mainView === 'map') _scheduleMapOverlayRefresh();
      _applyMapUiToDom();
    });
  }

  if (els.mapPinsMax) {
    els.mapPinsMax.addEventListener('change', () => {
      state.mapUi.pinsMax = _clampPinsMax(els.mapPinsMax.value);
      els.mapPinsMax.value = String(state.mapUi.pinsMax);
      _writeSetting(MAP_SETTINGS.pinsMax, String(state.mapUi.pinsMax));
      _setStatusSafe(`Map: Max pins ${state.mapUi.pinsMax}`);
      if (els.chart?.dataset?.mainView === 'map' && state.mapUi.pinsEnabled) _scheduleMapOverlayRefresh();
    });
  }

  if (els.mapScope) {
    els.mapScope.addEventListener('change', () => {
      const scope = String(els.mapScope.value || 'selected_person').trim().toLowerCase();
      state.mapUi.scope = scope;
      _writeSetting(MAP_SETTINGS.scope, scope);
      _setStatusSafe(`Map: Scope ${scope.replace('_', ' ')}`);
      if (els.chart?.dataset?.mainView === 'map') _scheduleMapOverlayRefresh();
    });
  }

  if (els.mapRoutesToggle) {
    els.mapRoutesToggle.addEventListener('click', () => {
      state.mapUi.routesEnabled = !state.mapUi.routesEnabled;
      _writeSetting(MAP_SETTINGS.routesEnabled, state.mapUi.routesEnabled ? '1' : '0');
      _setStatusSafe(state.mapUi.routesEnabled ? 'Map: Routes on' : 'Map: Routes off');
      if (els.chart?.dataset?.mainView === 'map') _scheduleMapOverlayRefresh();
      _applyMapUiToDom();
    });
  }

  if (els.mapRoutesMode) {
    els.mapRoutesMode.addEventListener('change', () => {
      const mode = String(els.mapRoutesMode.value || 'person').trim().toLowerCase();
      state.mapUi.routesMode = mode;
      _writeSetting(MAP_SETTINGS.routesMode, mode);
      _setStatusSafe(`Map: Routes mode ${mode}`);
      if (els.chart?.dataset?.mainView === 'map' && state.mapUi.routesEnabled) _scheduleMapOverlayRefresh();
    });
  }

  if (els.mapRoutesSkipRepeated) {
    els.mapRoutesSkipRepeated.addEventListener('change', () => {
      state.mapUi.routesSkipRepeated = !!els.mapRoutesSkipRepeated.checked;
      _writeSetting(MAP_SETTINGS.routesSkipRepeated, state.mapUi.routesSkipRepeated ? '1' : '0');
      if (els.chart?.dataset?.mainView === 'map' && state.mapUi.routesEnabled) _scheduleMapOverlayRefresh();
    });
  }

  if (els.mapFitPinsBtn) {
    els.mapFitPinsBtn.addEventListener('click', () => {
      _fitMapToOverlays({ quiet: false });
    });
  }

  if (els.mapClearOverlaysBtn) {
    els.mapClearOverlaysBtn.addEventListener('click', () => {
      state.mapUi.pinsEnabled = false;
      state.mapUi.routesEnabled = false;
      _writeSetting(MAP_SETTINGS.pinsEnabled, '0');
      _writeSetting(MAP_SETTINGS.routesEnabled, '0');
      try { state.map.pinsLayer?.clearLayers?.(); } catch (_) {}
      try { state.map.routesLayer?.clearLayers?.(); } catch (_) {}
      state.mapUi.pinsCount = 0;
      state.mapUi.routePoints = 0;
      _applyMapUiToDom();
      _setStatusSafe('Map: Overlays cleared');
    });
  }
}

async function _ensureLeafletLoaded() {
  if (state.map.leafletReady && window.L) return;
  if (state.map.leafletLoading) {
    // Wait until the script sets leafletReady.
    let tries = 0;
    while (!state.map.leafletReady && tries < 120) {
      await new Promise((r) => setTimeout(r, 50));
      tries++;
    }
    return;
  }
  state.map.leafletLoading = true;

  const ensureCss = () => {
    const id = 'leaflet-css';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  };

  const ensureJs = () => new Promise((resolve, reject) => {
    const id = 'leaflet-js';
    if (document.getElementById(id)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = id;
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Leaflet'));
    document.head.appendChild(script);
  });

  try {
    ensureCss();
    await ensureJs();
    state.map.leafletReady = Boolean(window.L);
  } catch (_) {
    state.map.leafletReady = false;
  } finally {
    state.map.leafletLoading = false;
  }
}

export async function ensureMapInitialized() {
  if (!els.mapView) return;
  if (state.map.map) return;
  await _ensureLeafletLoaded();
  if (!window.L) {
    // Fallback: keep a simple placeholder message.
    els.mapView.textContent = 'Map failed to load (Leaflet unavailable).';
    return;
  }

  // Leaflet expects the container to have real dimensions.
  // Only initialize when the map is actually visible.
  if (els.chart?.dataset?.mainView !== 'map') return;

  const L = window.L;
  const map = L.map(els.mapView, {
    zoomControl: true,
    attributionControl: false,
    preferCanvas: true,
  });

  // Default view: Netherlands-ish.
  map.setView([52.2, 5.3], 7);

  state.map.map = map;
  _ensureBaseLayers();
  _applyBasemap();

  // Overlay layers (pins/routes)
  _ensureOverlayLayers();
  _setMapOverlaysVisible(true);

  // Keep the map responsive when the main view toggles.
  try {
    window.addEventListener('resize', () => {
      try { map.invalidateSize(false); } catch (_err2) {}
    });
  } catch (_err) {}
}

export function resolvePlaceForMap(placeLike) {
  const place = (typeof placeLike === 'string') ? { id: placeLike } : (placeLike || null);
  if (!place) return null;
  const pid = String(place?.id || '').trim();
  if (!pid) return null;

  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  if (hasCoords) return place;

  // If we only got an id/name (e.g. from an event payload), upgrade it from the loaded places list.
  const hit = state.placeById?.get?.(pid) || null;
  return hit || place;
}

export function centerMapOnPlace(place) {
  const p = place || null;
  if (!p) return;
  const lat = Number(p?.lat);
  const lon = Number(p?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (!state.map.map || !window.L) return;

  const L = window.L;
  const map = state.map.map;
  const pid = String(p?.id || '').trim();
  const label = String(p?.name || '').trim();

  try {
    map.setView([lat, lon], Math.max(10, map.getZoom() || 10), { animate: true, duration: 0.25 });
  } catch (_err) {
    try { map.setView([lat, lon], 10); } catch (_err2) {}
  }

  try {
    if (state.map.marker) {
      state.map.marker.setLatLng([lat, lon]);
    } else {
      state.map.marker = L.marker([lat, lon]);
      state.map.marker.addTo(map);
    }
    if (label) state.map.marker.bindPopup(label);
  } catch (_) {}

  if (pid) state.map.lastCenteredPlaceId = pid;
}

export function onLeaveMapTab() {
  _closeMapPopovers();
  _setMapOverlaysVisible(false);
}

export function onEnterMapTab() {
  // If we're not going to center a specific place, auto-fit once after the
  // overlays render so pins are discoverable.
  try {
    const hasPendingPlace = !!String(state.map.pendingPlaceId || state.placesSelected || '').trim();
    state.mapUi.autoFitPending = !hasPendingPlace;
  } catch (_) {}

  // Lazy-init map; also invalidate size after the fade completes.
  Promise.resolve(ensureMapInitialized()).then(() => {
    try { state.map.map?.invalidateSize?.(false); } catch (_) {}

    // Ensure overlays reflect current settings.
    try { _applyMapUiToDom(); } catch (_) {}
    try { _applyBasemap(); } catch (_) {}
    try { _scheduleMapOverlayRefresh(); } catch (_) {}

    // If we already have a selected place, center it now that the map is visible.
    try {
      const pid = String(state.map.pendingPlaceId || state.placesSelected || '').trim();
      if (pid) {
        const p = resolvePlaceForMap(pid);
        centerMapOnPlace(p);
      }
    } catch (_) {}
  });
}
