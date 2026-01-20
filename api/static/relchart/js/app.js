import * as api from './api.js';
import { renderRelationshipChart } from './chart/render.js';
import { mergeGraphPayload } from './chart/payload.js';
import { formatGrampsDateEnglish, formatGrampsDateEnglishCard } from './util/date.js';

import { els, state, MAP_SETTINGS, _readBool, _readInt, _writeSetting } from './state.js';
import { _cssEscape } from './util/dom.js';
import { _isInsideDetailsOrPortal, _portalDetailsPanel, _unportalDetailsPanel } from './features/portal.js';
import {
  initPeopleFeature,
  selection,
  ensurePeopleIndexLoaded,
  ensurePeopleLoaded,
  _applyPeopleSelectionToDom,
  _renderPeopleList,
} from './features/people.js';

function _setTopbarControlsMode(kind) {
  const k = String(kind || '').trim().toLowerCase();
  const showMap = (k === 'map');
  if (els.graphControls) els.graphControls.hidden = showMap;
  if (els.mapControls) els.mapControls.hidden = !showMap;
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
  const root = _resolveRelationsRootPersonId();
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

  const root = _resolveRelationsRootPersonId();
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
  await ensurePlacesLoaded();
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
      setStatus(`Map: pins failed (${e?.message || e})`, true);
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
          try { _selectPlaceGlobal(p, { emitMapEvent: true }); } catch (_) {}
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
      setStatus(`Map: routes failed (${e?.message || e})`, true);
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
    if (!quiet) setStatus('Map: nothing to fit.', true);
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
      setStatus(`Map: Basemap ${state.mapUi.basemap === 'aerial' ? 'Aerial' : 'Topo'}`);
    });
  }

  if (els.mapPinsEnabled) {
    els.mapPinsEnabled.addEventListener('change', () => {
      state.mapUi.pinsEnabled = !!els.mapPinsEnabled.checked;
      _writeSetting(MAP_SETTINGS.pinsEnabled, state.mapUi.pinsEnabled ? '1' : '0');
      setStatus(state.mapUi.pinsEnabled ? 'Map: Pins on' : 'Map: Pins off');
      if (els.chart?.dataset?.mainView === 'map') _scheduleMapOverlayRefresh();
      _applyMapUiToDom();
    });
  }

  if (els.mapPinsMax) {
    els.mapPinsMax.addEventListener('change', () => {
      state.mapUi.pinsMax = _clampPinsMax(els.mapPinsMax.value);
      els.mapPinsMax.value = String(state.mapUi.pinsMax);
      _writeSetting(MAP_SETTINGS.pinsMax, String(state.mapUi.pinsMax));
      setStatus(`Map: Max pins ${state.mapUi.pinsMax}`);
      if (els.chart?.dataset?.mainView === 'map' && state.mapUi.pinsEnabled) _scheduleMapOverlayRefresh();
    });
  }

  if (els.mapScope) {
    els.mapScope.addEventListener('change', () => {
      const scope = String(els.mapScope.value || 'selected_person').trim().toLowerCase();
      state.mapUi.scope = scope;
      _writeSetting(MAP_SETTINGS.scope, scope);
      setStatus(`Map: Scope ${scope.replace('_', ' ')}`);
      if (els.chart?.dataset?.mainView === 'map') _scheduleMapOverlayRefresh();
    });
  }

  if (els.mapRoutesToggle) {
    els.mapRoutesToggle.addEventListener('click', () => {
      state.mapUi.routesEnabled = !state.mapUi.routesEnabled;
      _writeSetting(MAP_SETTINGS.routesEnabled, state.mapUi.routesEnabled ? '1' : '0');
      setStatus(state.mapUi.routesEnabled ? 'Map: Routes on' : 'Map: Routes off');
      if (els.chart?.dataset?.mainView === 'map') _scheduleMapOverlayRefresh();
      _applyMapUiToDom();
    });
  }

  if (els.mapRoutesMode) {
    els.mapRoutesMode.addEventListener('change', () => {
      const mode = String(els.mapRoutesMode.value || 'person').trim().toLowerCase();
      state.mapUi.routesMode = mode;
      _writeSetting(MAP_SETTINGS.routesMode, mode);
      setStatus(`Map: Routes mode ${mode}`);
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
      setStatus('Map: Overlays cleared');
    });
  }
}

function _applyPlacesMenuButtonVisibility() {
  if (!els.placesList) return;
  for (const b of els.placesList.querySelectorAll('.placeEventsMenuBtn[data-place-id]')) {
    const pid = String(b?.dataset?.placeId || '').trim();
    if (!pid) continue;
    const count = Number(state.placeEventCountById?.get?.(pid));
    const has = Number.isFinite(count) && count > 0;
    b.style.visibility = has ? 'visible' : 'hidden';
  }
}

function _ensurePlaceEventsPanel() {
  if (els.placeEventsPanel && document.body.contains(els.placeEventsPanel)) return;

  const panel = document.createElement('div');
  panel.className = 'placeEventsPanel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="placeEventsPanelHeader">
      <div class="placeEventsPanelTitle" data-place-events-title="1">Place Events</div>
      <button class="placeEventsPanelClose" type="button" data-place-events-close="1" title="Close">×</button>
    </div>
    <div class="placeEventsPanelBody" data-place-events-body="1"></div>
  `;

  panel.addEventListener('click', (e) => {
    const t = e?.target;
    const el = (t && t.nodeType === 1) ? t : t?.parentElement;
    const closeBtn = el && el.closest ? el.closest('[data-place-events-close="1"]') : null;
    if (!closeBtn) return;
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (_) {}
    _closePlaceEventsPanel();
  });

  // Delegated click: select person from the place-events list.
  panel.addEventListener('click', (e) => {
    const t = e?.target;
    const el = (t && t.nodeType === 1) ? t : t?.parentElement;
    const btn = el && el.closest ? el.closest('.placeEventPersonLink[data-person-api], .placeEventPersonLink[data-person-gramps]') : null;
    if (!btn) return;

    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (_) {}

    const apiId = String(btn?.dataset?.personApi || '').trim() || null;
    const grampsId = String(btn?.dataset?.personGramps || '').trim() || null;
    if (!apiId && !grampsId) return;

    const activeTab = _getSidebarActiveTab();
    try {
      selection.selectPerson(
        { apiId, grampsId },
        { source: 'place-events', scrollPeople: activeTab === 'people', updateInput: true },
      );
    } catch (_) {}

    try { els.personId.value = grampsId || apiId || ''; } catch (_) {}
    try { Promise.resolve().then(loadNeighborhood); } catch (_) {}

    const who = String(btn?.textContent || '').trim() || grampsId || apiId;
    try { setStatus(`Selected: ${who}`); } catch (_) {}
  });

  try {
    window.addEventListener('resize', () => {
      _positionPlaceEventsPanel();
    });
  } catch (_) {}

  els.placeEventsPanel = panel;
  document.body.appendChild(panel);
}

function _closePlaceEventsPanel() {
  state.placeEventsPanel.open = false;
  state.placeEventsPanel.placeId = null;
  if (els.placeEventsPanel) {
    els.placeEventsPanel.hidden = true;
    els.placeEventsPanel._anchorEl = null;
  }
}

function _positionPlaceEventsPanel(anchorEl) {
  const panel = els.placeEventsPanel;
  if (!panel || panel.hidden) return;

  const a = anchorEl || panel._anchorEl || null;
  if (!a || typeof a.getBoundingClientRect !== 'function') {
    _closePlaceEventsPanel();
    return;
  }
  const r = a.getBoundingClientRect();

  // If the anchor is fully out of view, close the panel.
  // This avoids the panel sticking to the top/bottom edge when scrolling.
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
    _closePlaceEventsPanel();
    return;
  }

  const margin = 10;
  const gap = 10;
  const w = 380;
  const maxH = Math.min(520, (window.innerHeight || 800) - (margin * 2));

  let left = r.right + gap;
  let top = r.top - 8;

  if (left + w + margin > vw) left = Math.max(margin, vw - w - margin);
  if (top + 120 > vh - margin) top = Math.max(margin, vh - 120 - margin);
  if (top < margin) top = margin;

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${w}px`;
  panel.style.maxHeight = `${maxH}px`;
}

async function _ensurePlaceEventsLoaded(placeId) {
  const pid = String(placeId || '').trim();
  if (!pid) return [];
  if (state.placeEventsByPlaceId.has(pid)) return state.placeEventsByPlaceId.get(pid) || [];

  const params = new URLSearchParams();
  params.set('place_id', pid);
  params.set('limit', '2000');
  params.set('offset', '0');
  params.set('sort', 'year_asc');

  const r = await fetch(`/events?${params.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  state.placeEventsByPlaceId.set(pid, results);
  return results;
}

function _renderPlaceEventsPanelBody(placeId, events) {
  const panel = els.placeEventsPanel;
  if (!panel) return;
  const titleEl = panel.querySelector('[data-place-events-title="1"]');
  const bodyEl = panel.querySelector('[data-place-events-body="1"]');
  if (!bodyEl) return;

  const pid = String(placeId || '').trim();
  const place = state.placeById?.get?.(pid) || null;
  const title = place ? _placeLabel(place) : `Place ${pid}`;
  if (titleEl) titleEl.textContent = `Events · ${title}`;

  const evs = Array.isArray(events) ? events : [];
  if (!evs.length) {
    bodyEl.innerHTML = `<div class="placeEventsEmpty">No public events found for this place.</div>`;
    return;
  }

  const items = evs.map((ev) => {
    const apiId = String(ev?.id || '').trim();
    const gid = String(ev?.gramps_id || '').trim();
    const idLabel = gid || apiId;
    const eventTitle = _formatEventTitle(ev);
    const primary = ev?.primary_person || null;
    const primaryName = String(primary?.display_name || '').trim();
    const primaryApiId = String(primary?.id || '').trim();
    const primaryGrampsId = String(primary?.gramps_id || '').trim();
    const sub = _formatEventSubLineNoPlace(ev);
    const desc = String(ev?.description || '').trim();

    const primaryHtml = (primaryName && (primaryApiId || primaryGrampsId))
      ? `<button type="button" class="eventPrimary placeEventPersonLink" data-person-api="${_escapeHtml(primaryApiId)}" data-person-gramps="${_escapeHtml(primaryGrampsId)}" title="Select person">${_escapeHtml(primaryName)}</button>`
      : `<div class="eventPrimary" title="${_escapeHtml(primaryName)}">${_escapeHtml(primaryName)}</div>`;

    return `
      <div class="peopleItem eventsItem" data-event-id="${_escapeHtml(apiId)}">
        <div class="eventGrid">
          <div class="eventRow1">
            <div class="eventType">${_escapeHtml(eventTitle)}</div>
            ${primaryHtml}
          </div>
          <div class="eventMetaLeft">${_escapeHtml(sub)}</div>
          <div class="eventMetaRight">${_escapeHtml(idLabel)}</div>
          ${desc ? `<div class="eventDescLine" style="grid-column: 1 / -1" title="${_escapeHtml(desc)}">${_escapeHtml(desc)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  bodyEl.innerHTML = `<div class="peopleList placeEventList">${items}</div>`;
}

async function _togglePlaceEventsPanel(placeId, anchorEl) {
  const pid = String(placeId || '').trim();
  if (!pid) return;

  _ensurePlaceEventsPanel();
  const panel = els.placeEventsPanel;
  if (!panel) return;

  if (state.placeEventsPanel.open && state.placeEventsPanel.placeId === pid) {
    _closePlaceEventsPanel();
    return;
  }

  state.placeEventsPanel.open = true;
  state.placeEventsPanel.placeId = pid;
  panel._anchorEl = anchorEl || null;
  panel.hidden = false;
  _positionPlaceEventsPanel(anchorEl);

  // Loading state
  try {
    const bodyEl = panel.querySelector('[data-place-events-body="1"]');
    if (bodyEl) bodyEl.innerHTML = '<div class="placeEventsLoading">Loading events…</div>';
  } catch (_) {}

  let events = [];
  try {
    events = await _ensurePlaceEventsLoaded(pid);
  } catch (e) {
    try {
      const bodyEl = panel.querySelector('[data-place-events-body="1"]');
      if (bodyEl) bodyEl.innerHTML = `<div class="placeEventsEmpty">Failed to load events: ${_escapeHtml(e?.message || e)}</div>`;
    } catch (_) {}
    return;
  }

  _renderPlaceEventsPanelBody(pid, events);
  _positionPlaceEventsPanel(anchorEl);
}

function _setMainView(viewName) {
  const v = String(viewName || '').trim().toLowerCase();
  if (!els.chart) return;
  els.chart.dataset.mainView = (v === 'map') ? 'map' : 'graph';
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

async function ensureMapInitialized() {
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

function _resolvePlaceForMap(placeLike) {
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

function _centerMapOnPlace(place) {
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

function _eventGrampsId(ev) {
  const g = String(ev?.gramps_id || '').trim();
  return g || '';
}

function _sortEventsForSidebar(events, sortModeRaw) {
  const mode = String(sortModeRaw || 'type_asc').trim().toLowerCase();
  const src = Array.isArray(events) ? events : [];
  const out = src.slice();

  const dir = mode.endsWith('_desc') ? -1 : 1;
  const kind = mode.replace(/_(asc|desc)$/, '');

  const cmpStr = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });

  out.sort((a, b) => {
    if (kind === 'year') {
      const ya = _eventYearHint(a);
      const yb = _eventYearHint(b);
      const ha = (typeof ya === 'number') && Number.isFinite(ya);
      const hb = (typeof yb === 'number') && Number.isFinite(yb);
      // Always push unknown years to the bottom.
      if (ha !== hb) return ha ? -1 : 1;
      if (ha && hb && ya !== yb) return (ya - yb) * dir;
      // Tiebreakers for stable ordering.
      const t = cmpStr(a?.type, b?.type);
      if (t) return t;
      const gid = cmpStr(_eventGrampsId(a) || a?.id, _eventGrampsId(b) || b?.id);
      return gid;
    }

    if (kind === 'id') {
      const c = cmpStr(_eventGrampsId(a) || a?.id, _eventGrampsId(b) || b?.id);
      if (c) return c * dir;
      const t = cmpStr(a?.type, b?.type);
      return t;
    }

    // Default: type
    const c = cmpStr(a?.type, b?.type);
    if (c) return c * dir;
    const y = (_eventYearHint(a) ?? 999999) - (_eventYearHint(b) ?? 999999);
    if (y) return y;
    return cmpStr(_eventGrampsId(a) || a?.id, _eventGrampsId(b) || b?.id);
  });

  return out;
}

function _formatEventTitle(ev) {
  const t = String(ev?.type || ev?.event_type || 'Event').trim();
  return t || 'Event';
}

function _formatEventPlaceForSidebar(ev) {
  const full = String(ev?.place?.name || '').trim();
  if (!full) return '';

  // Heuristic: if the place ends with "Netherlands"/"Nederland" (or "NL"), hide the country.
  // If it's outside NL, keep the full place string (which should include the country).
  const parts = full.split(',').map(s => String(s).trim()).filter(Boolean);
  if (parts.length < 2) return full;
  const country = String(parts[parts.length - 1] || '').trim();
  if (/^(netherlands|nederland|nl)$/i.test(country)) {
    return parts.slice(0, -1).join(', ');
  }
  return full;
}

function _formatEventSubLine(ev) {
  const dateText = String(ev?.date || ev?.date_text || ev?.event_date || ev?.event_date_text || '').trim();
  const dateUi = dateText ? formatGrampsDateEnglish(dateText) : '';
  const placeName = _formatEventPlaceForSidebar(ev);
  const parts = [];
  if (dateUi) parts.push(dateUi);
  if (placeName) parts.push(placeName);
  return parts.join(' · ');
}

function _formatEventSubLineNoPlace(ev) {
  const dateText = String(ev?.date || ev?.date_text || ev?.event_date || ev?.event_date_text || '').trim();
  const dateUi = dateText ? formatGrampsDateEnglish(dateText) : '';
  return dateUi;
}

function _renderEventsList(events, query) {
  if (!els.eventsList) return;
  const src = Array.isArray(events) ? events : [];
  const ordered = state.eventsServerMode ? src : _sortEventsForSidebar(src, state.eventsSort || 'type_asc');
  const qn = state.eventsServerMode ? '' : _normKey(query);
  const filtered = qn
    ? ordered.filter((ev) => {
        const title = _formatEventTitle(ev);
        const sub = _formatEventSubLine(ev);
        const desc = String(ev?.description || '').trim();
        const apiId = String(ev?.id || '').trim();
        const gid = _eventGrampsId(ev);
        const primary = ev?.primary_person || null;
        const primaryName = String(primary?.display_name || '').trim();
        const primaryApiId = String(primary?.id || '').trim();
        const primaryGid = String(primary?.gramps_id || '').trim();
        return _normKey(
          `${title} ${sub} ${desc} ${gid} ${apiId} ${primaryName} ${primaryGid} ${primaryApiId}`
        ).includes(qn);
      })
    : ordered;

  els.eventsList.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const ev of filtered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'peopleItem eventsItem';
    const apiId = String(ev?.id || '').trim();
    const gid = _eventGrampsId(ev);
    btn.dataset.eventId = apiId;
    if (state.eventsSelected && apiId && state.eventsSelected === apiId) {
      btn.classList.add('selected');
    }

    const grid = document.createElement('div');
    grid.className = 'eventGrid';

    const row1 = document.createElement('div');
    row1.className = 'eventRow1';

    // Row 1
    const r1l = document.createElement('div');
    r1l.className = 'eventType';
    r1l.textContent = _formatEventTitle(ev);

    const primary = ev?.primary_person || null;
    const primaryName = String(primary?.display_name || '').trim();
    const r1r = document.createElement('div');
    r1r.className = 'eventPrimary';
    r1r.textContent = primaryName || '';
    if (primaryName) r1r.title = primaryName;

    // Row 2
    const r2l = document.createElement('div');
    r2l.className = 'eventMetaLeft';
    r2l.textContent = _formatEventSubLine(ev);

    const r2r = document.createElement('div');
    r2r.className = 'eventMetaRight';
    r2r.textContent = gid || apiId;

    // Row 3 (optional)
    const desc = String(ev?.description || '').trim();
    const r3 = document.createElement('div');
    r3.className = 'eventDescLine';
    r3.textContent = desc;
    if (desc) r3.title = desc;

    row1.appendChild(r1l);
    row1.appendChild(r1r);

    grid.appendChild(row1);
    grid.appendChild(r2l);
    grid.appendChild(r2r);
    if (desc) {
      // span 2 columns
      r3.style.gridColumn = '1 / -1';
      grid.appendChild(r3);
    }

    btn.appendChild(grid);

    btn.addEventListener('click', () => {
      if (!apiId) return;
      state.eventsSelected = apiId;
      try {
        for (const el of els.eventsList.querySelectorAll('.peopleItem.selected')) el.classList.remove('selected');
        btn.classList.add('selected');
      } catch (_) {}

      const primaryApiId = String(primary?.id || '').trim();
      const primaryGrampsId = String(primary?.gramps_id || '').trim();

      if (primaryApiId || primaryGrampsId) {
        const activeTab = _getSidebarActiveTab();
        selection.selectPerson(
          { apiId: primaryApiId || null, grampsId: primaryGrampsId || null },
          { source: 'events-list', scrollPeople: activeTab === 'people', updateInput: true },
        );

        // Ensure the form input is usable even if gramps_id is missing.
        try { els.personId.value = primaryGrampsId || primaryApiId; } catch (_) {}

        // Load the neighborhood for the selected primary person.
        Promise.resolve().then(loadNeighborhood);

        const name = String(primary?.display_name || '').trim();
        const who = name || primaryGrampsId || primaryApiId;
        setStatus(`Event: ${gid || apiId} · selected ${who}`);
      } else {
        const msg = `Event: ${gid || apiId} (no primary person)`;
        setStatus(msg);
        copyToClipboard(`event_id=${apiId}${gid ? `\ngramps_id=${gid}` : ''}`).then((ok) => {
          if (ok) setStatus(msg + ' (copied)');
        });
      }
    });

    frag.appendChild(btn);
  }

  els.eventsList.appendChild(frag);
  if (els.eventsStatus) {
    if (state.eventsServerMode) {
      const loaded = src.length;
      const total = Number.isFinite(state.eventsTotal) ? state.eventsTotal : null;
      const more = state.eventsHasMore ? ' (scroll to load more)' : '';
      els.eventsStatus.textContent = total !== null ? `Showing ${loaded} of ${total}.${more}` : `Showing ${loaded}.${more}`;
    } else {
      els.eventsStatus.textContent = `Showing ${filtered.length} of ${src.length}.`;
    }
  }
}

let _detailPeekTabEl = null;

function _ensureDetailPeekTab() {
  if (_detailPeekTabEl && _detailPeekTabEl.isConnected) return _detailPeekTabEl;
  const existing = document.getElementById('detailPeekTab');
  if (existing) {
    _detailPeekTabEl = existing;
    return existing;
  }
  const btn = document.createElement('button');
  btn.id = 'detailPeekTab';
  btn.type = 'button';
  btn.className = 'detailPeekTab';
  btn.hidden = true;
  btn.title = 'Show person details';
  btn.setAttribute('aria-label', 'Show person details');

  const imgWrap = document.createElement('div');
  imgWrap.className = 'detailPeekImg';
  imgWrap.dataset.peekImg = '1';
  btn.appendChild(imgWrap);

  btn.addEventListener('click', () => {
    showPersonDetailPanel();
  });

  try { document.body.appendChild(btn); } catch (_) {}
  _detailPeekTabEl = btn;
  return btn;
}

function _positionDetailPeekTab() {
  const el = _ensureDetailPeekTab();
  if (!el || !els.chart) return;
  try {
    const r = els.chart.getBoundingClientRect();
    // Place near the top-right corner of the chart area.
    const top = Math.max(8, (r.top || 0) + 10);
    el.style.top = `${top}px`;
  } catch (_) {}
}

function _updateDetailPeekTab() {
  const el = _ensureDetailPeekTab();
  if (!el) return;
  const imgHost = el.querySelector('[data-peek-img="1"]');
  if (!imgHost) return;
  imgHost.innerHTML = '';
  const url = String(state.detailPanel.peek?.url || '').trim();
  const name = String(state.detailPanel.peek?.name || '').trim();
  const isLoading = !!state.detailPanel.peek?.loading;
  el.title = name ? `Show details: ${name}` : 'Show person details';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = name ? `${name} portrait` : 'Portrait';
    img.loading = 'lazy';
    img.decoding = 'async';
    imgHost.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'detailPeekPlaceholder';
    // While loading, keep the tab visually blank (no "L" from "Loading…").
    ph.textContent = isLoading ? '' : (name ? name.trim().slice(0, 1).toUpperCase() : '•');
    imgHost.appendChild(ph);
  }
}

function _setDetailPeekVisible(visible) {
  const el = _ensureDetailPeekTab();
  if (!el) return;
  el.hidden = !visible;
  if (visible) {
    _updateDetailPeekTab();
    _positionDetailPeekTab();
  }
}

function _formatFamilyLabel(f) {
  const fa = f?.father || null;
  const mo = f?.mother || null;
  const faName = String(fa?.display_name || '').trim();
  const moName = String(mo?.display_name || '').trim();

  if (faName && moName) return `${faName} × ${moName}`;
  if (faName) return `${faName} × (unknown)`;
  if (moName) return `(unknown) × ${moName}`;
  return '(unknown parents)';
}

function _formatFamilyMeta(f) {
  const parts = [];
  const m = String(f?.marriage || '').trim();
  if (m) {
    const dm = formatGrampsDateEnglishCard(m);
    if (dm) parts.push(`⚭ ${dm}`);
  }
  return parts.join(' · ');
}

function _formatFamilyIdText(f) {
  return String(f?.gramps_id || f?.id || '').trim();
}

function _formatFamilyMarriageText(f) {
  const m = String(f?.marriage || '').trim();
  if (!m) return '';
  const dm = formatGrampsDateEnglishCard(m);
  return dm ? `⚭ ${dm}` : '';
}

function _formatFamilyChildrenText(f) {
  const kids = Number(f?.children_total);
  if (!Number.isFinite(kids)) return '';
  return `${kids} child${kids === 1 ? '' : 'ren'}`;
}

function _applyFamiliesSelectionToDom({ scroll = true } = {}) {
  if (!els.familiesList) return;
  const key = String(state.familiesSelected || '').trim();

  for (const el of els.familiesList.querySelectorAll('.peopleItem.selected')) {
    el.classList.remove('selected');
  }

  if (!key) return;

  // Families are virtualized; the selected row element can be replaced during
  // scroll/render. Re-query each attempt so we don't center a detached node.
  const scrollContainer = els.familiesList;
  const selector = `.peopleItem[data-family-key="${_cssEscape(key)}"]`;

  const centerSelected = () => {
    const sel = scrollContainer.querySelector(selector);
    if (!sel) return;
    sel.classList.add('selected');
    if (!scroll) return;

    try {
      const cRect = scrollContainer.getBoundingClientRect();
      const eRect = sel.getBoundingClientRect();
      if (!cRect || !eRect) return;
      const desiredCenter = cRect.top + (cRect.height / 2);
      const currentCenter = eRect.top + (eRect.height / 2);
      const delta = currentCenter - desiredCenter;
      if (!Number.isFinite(delta)) return;
      scrollContainer.scrollTop += delta;
    } catch (_err) {
      try { sel.scrollIntoView({ block: 'center' }); } catch (_err2) {
        try { sel.scrollIntoView(); } catch (_err3) {}
      }
    }
  };

  try {
    requestAnimationFrame(() => {
      centerSelected();
      requestAnimationFrame(centerSelected);
    });
  } catch (_) {
    centerSelected();
  }
}

function setSelectedFamilyKey(key, { source: _source = 'unknown', scrollFamilies = true } = {}) {
  const k = String(key || '').trim();
  if (k && state.familiesSelected === k) return;
  state.familiesSelected = k || null;
  if (scrollFamilies) {
    try { _scrollFamiliesToKey(state.familiesSelected); } catch (_) {}
  }
  // Ensure highlighting updates even if the selected row isn't currently rendered.
  try { _renderFamiliesViewport(); } catch (_) {}

  // After virtualization scroll+render, do a DOM-based centering pass so the
  // selected row lands correctly on the first click.
  if (scrollFamilies) {
    try { _applyFamiliesSelectionToDom({ scroll: true }); } catch (_) {}
  }
}

const _FAMILY_ROW_H = 56; // fixed; must match CSS for stable virtualization
const _FAMILY_OVERSCAN = 10;
let _familiesAll = [];
let _familiesFiltered = [];
let _familiesQueryNorm = '';
let _familiesIndexByKey = new Map();
let _familiesViewportWired = false;
let _familiesRenderPending = false;

function _buildFamiliesIndex(families) {
  _familiesIndexByKey = new Map();
  for (let i = 0; i < families.length; i++) {
    const f = families[i];
    const key = String(f?.gramps_id || f?.id || '').trim();
    if (!key) continue;
    if (!_familiesIndexByKey.has(key)) _familiesIndexByKey.set(key, i);
  }
}

function _scrollFamiliesToKey(key) {
  const k = String(key || '').trim();
  if (!k || !els.familiesList) return;
  const idx = _familiesIndexByKey.get(k);
  if (typeof idx !== 'number' || !Number.isFinite(idx)) return;
  // Center the row (by its midpoint), with a tiny nudge upward so it doesn't
  // sit right on the bottom edge of the clipped/rounded scroll viewport.
  const host = els.familiesList;
  const rowH = _FAMILY_ROW_H;
  const viewportH = host.clientHeight || 0;
  const nudgePx = 10;
  const desiredTop = idx * rowH - (viewportH - rowH) / 2 + nudgePx;
  const maxTop = Math.max(0, (host.scrollHeight || 0) - viewportH);
  const top = Math.max(0, Math.min(maxTop, desiredTop));
  host.scrollTop = top;
}

function _wireFamiliesViewport() {
  if (!els.familiesList) return;
  if (_familiesViewportWired) return;
  _familiesViewportWired = true;

  els.familiesList.addEventListener('scroll', () => {
    // Keep scroll handler light; render at most once per frame.
    if (_familiesRenderPending) return;
    _familiesRenderPending = true;
    const run = () => {
      _familiesRenderPending = false;
      _renderFamiliesViewport();
    };
    try { requestAnimationFrame(run); } catch (_) { run(); }
  }, { passive: true });
}

function _renderFamilyRow(f, key, seed) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'peopleItem familyItem';
  btn.dataset.familyKey = key;
  btn.dataset.familySeed = seed;
  if (state.familiesSelected && state.familiesSelected === key) {
    btn.classList.add('selected');
  }

  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = '';

  const faName = String(f?.father?.display_name || '').trim();
  const moName = String(f?.mother?.display_name || '').trim();

  const primaryLine = document.createElement('div');
  primaryLine.className = 'familyNameLine familyNamePrimary';

  const fatherEl = document.createElement('span');
  fatherEl.className = 'familyFather';
  fatherEl.textContent = faName || '(unknown)';

  const marriageEl = document.createElement('span');
  marriageEl.className = 'familyMarriage';
  marriageEl.textContent = _formatFamilyMarriageText(f);

  const idEl = document.createElement('span');
  idEl.className = 'familyId';
  idEl.textContent = _formatFamilyIdText(f);

  primaryLine.appendChild(fatherEl);
  primaryLine.appendChild(marriageEl);
  primaryLine.appendChild(idEl);
  nameEl.appendChild(primaryLine);

  const secondaryLine = document.createElement('div');
  secondaryLine.className = 'familyNameLine familyNameSecondary';
  secondaryLine.textContent = '';

  const motherEl = document.createElement('span');
  motherEl.className = 'familyMother';
  motherEl.textContent = moName || '(unknown)';
  secondaryLine.appendChild(motherEl);

  const kidsText = _formatFamilyChildrenText(f);
  if (kidsText) {
    const kidsEl = document.createElement('span');
    kidsEl.className = 'familyKids';
    kidsEl.textContent = kidsText;
    secondaryLine.appendChild(kidsEl);
  }
  nameEl.appendChild(secondaryLine);

  btn.appendChild(nameEl);
  return btn;
}

function _renderFamiliesViewport() {
  if (!els.familiesList) return;
  const host = els.familiesList;
  const families = Array.isArray(_familiesFiltered) ? _familiesFiltered : [];
  const total = families.length;

  // Ensure the host has our virtualization structure.
  let topPad = host.querySelector(':scope > .familyPadTop');
  let items = host.querySelector(':scope > .familyViewport');
  let botPad = host.querySelector(':scope > .familyPadBottom');
  if (!topPad || !items || !botPad) {
    host.innerHTML = '';
    topPad = document.createElement('div');
    topPad.className = 'familyPadTop';
    items = document.createElement('div');
    items.className = 'familyViewport';
    botPad = document.createElement('div');
    botPad.className = 'familyPadBottom';
    host.appendChild(topPad);
    host.appendChild(items);
    host.appendChild(botPad);
  }

  const scrollTop = host.scrollTop || 0;
  const viewportH = host.clientHeight || 0;
  const rowH = _FAMILY_ROW_H;
  const estVisible = Math.max(1, Math.ceil(viewportH / rowH));
  const start = Math.max(0, Math.floor(scrollTop / rowH) - _FAMILY_OVERSCAN);
  const end = Math.min(total, start + estVisible + _FAMILY_OVERSCAN * 2);

  topPad.style.height = `${start * rowH}px`;
  botPad.style.height = `${Math.max(0, (total - end) * rowH)}px`;

  items.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const f = families[i];
    const key = String(f?.gramps_id || f?.id || '').trim();
    const seed = String(
      f?.father?.gramps_id || f?.mother?.gramps_id || f?.father?.id || f?.mother?.id || ''
    ).trim();
    frag.appendChild(_renderFamilyRow(f, key, seed));
  }
  items.appendChild(frag);
}

function _renderFamiliesList(families, query) {
  if (!els.familiesList) return;
  _wireFamiliesViewport();
  const prevQ = _familiesQueryNorm;
  const qn = _normKey(query);
  _familiesAll = Array.isArray(families) ? families : [];
  _familiesQueryNorm = qn;
  _familiesFiltered = qn
    ? _familiesAll.filter((f) => {
        const label = _formatFamilyLabel(f);
        const meta = `${_formatFamilyMarriageText(f)} ${_formatFamilyIdText(f)}`.trim();
        const kids = _formatFamilyChildrenText(f);
        return _normKey(`${label} ${meta} ${kids}`).includes(qn);
      })
    : _familiesAll;

  _buildFamiliesIndex(_familiesFiltered);

  // Reset scroll only when query changes.
  if (qn !== prevQ) {
    try { els.familiesList.scrollTop = 0; } catch (_) {}
  }
  _renderFamiliesViewport();

  // If a family is already selected (e.g., from a graph click), scroll to it.
  if (state.familiesSelected && _familiesIndexByKey.has(state.familiesSelected)) {
    try { _scrollFamiliesToKey(state.familiesSelected); } catch (_) {}
    try { _renderFamiliesViewport(); } catch (_) {}
  }

  if (els.familiesStatus) {
    els.familiesStatus.textContent = `Showing ${_familiesFiltered.length} of ${_familiesAll.length}.`;
  }
}

function _wireFamiliesClicks() {
  if (!els.familiesList) return;
  if (state.familiesClicksWired) return;
  state.familiesClicksWired = true;

  els.familiesList.addEventListener('click', async (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest('button.familyItem[data-family-key]') : null;
    if (!btn || !els.familiesList.contains(btn)) return;

    const key = String(btn.dataset.familyKey || '').trim();
    const seed = String(btn.dataset.familySeed || '').trim();
    if (key) setSelectedFamilyKey(key, { source: 'families-list', scrollFamilies: false });

    if (!seed) {
      setStatus('Cannot load family: parents are not available.', true);
      return;
    }
    els.personId.value = seed;
    await loadNeighborhood();
  });
}

// --- Person detail panel (floating + draggable) ---
// Tweakable values:
const DETAIL_PANEL_POS_KEY = 'tree_relchart_person_panel_pos_v1';
const DETAIL_PANEL_DEFAULT_POS = { left: 48, top: 72 };

const DETAIL_PANEL_SIZE_KEY = 'tree_relchart_person_panel_size_v1';
const DETAIL_PANEL_DEFAULT_SIZE = { h: 620 };

function _clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function _loadDetailPanelPos() {
  let pos = { ...DETAIL_PANEL_DEFAULT_POS };
  try {
    const raw = String(localStorage.getItem(DETAIL_PANEL_POS_KEY) || '').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      const l = Number(parsed?.left);
      const t = Number(parsed?.top);
      if (Number.isFinite(l) && Number.isFinite(t)) pos = { left: l, top: t };
    }
  } catch (_) {}
  state.detailPanel.pos = pos;
}

function _saveDetailPanelPos() {
  try {
    localStorage.setItem(DETAIL_PANEL_POS_KEY, JSON.stringify(state.detailPanel.pos));
  } catch (_) {}
}

function _applyDetailPanelPos() {
  const el = els.personDetailPanel;
  if (!el) return;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const w = el.offsetWidth || 520;
  const h = el.offsetHeight || 620;
  const left = _clamp(state.detailPanel.pos.left, 8, Math.max(8, vw - w - 8));
  const top = _clamp(state.detailPanel.pos.top, 8, Math.max(8, vh - h - 8));
  state.detailPanel.pos = { left, top };
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function _loadDetailPanelSize() {
  let size = { ...DETAIL_PANEL_DEFAULT_SIZE };
  try {
    const raw = String(localStorage.getItem(DETAIL_PANEL_SIZE_KEY) || '').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      const h = Number(parsed?.h);
      if (Number.isFinite(h) && h > 0) size = { h };
    }
  } catch (_) {}
  state.detailPanel.size = size;
}

function _saveDetailPanelSize() {
  try {
    localStorage.setItem(DETAIL_PANEL_SIZE_KEY, JSON.stringify(state.detailPanel.size));
  } catch (_) {}
}

function _applyDetailPanelSize() {
  const el = els.personDetailPanel;
  if (!el) return;
  const vh = window.innerHeight || 800;
  const minH = 320;
  const maxH = Math.max(minH, vh - 16);
  const rawH = Number(state.detailPanel.size?.h ?? DETAIL_PANEL_DEFAULT_SIZE.h);
  const h = _clamp(rawH, minH, maxH);
  state.detailPanel.size.h = h;
  el.style.height = `${h}px`;
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



function _renderPersonDetailPanelSkeleton() {
  const host = els.personDetailPanel;
  if (!host) return;

  host.innerHTML = `
    <div class="personDetailHeader" data-panel-drag="1">
      <div class="personDetailTitle">
        <div class="personDetailAvatar" data-person-avatar="1"></div>
        <div class="personDetailTitleText">
          <div class="personDetailName" data-person-name="1">
            <span class="personDetailNameText" data-person-name-text="1">Person</span>
            <span class="personDetailGender" data-person-gender="1" aria-hidden="true"></span>
          </div>
          <div class="personDetailMeta" data-person-meta="1"></div>
        </div>
      </div>
      <div class="personDetailActions">
        <button class="personDetailIconBtn" type="button" data-panel-search="1" title="Search people" aria-label="Search people">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M10 4a6 6 0 1 1 0 12a6 6 0 0 1 0-12m0-2a8 8 0 1 0 4.9 14.3l4.4 4.4a1 1 0 0 0 1.4-1.4l-4.4-4.4A8 8 0 0 0 10 2z"/>
          </svg>
        </button>
        <div class="personDetailSearchPopover" data-panel-search-popover="1" hidden>
          <div class="personDetailSearchRow">
            <input class="personDetailSearchInput" type="text" data-panel-search-input="1" placeholder="Search people…" autocomplete="off" spellcheck="false" />
            <button class="personDetailSearchClose" type="button" data-panel-search-close="1" title="Close" aria-label="Close search">×</button>
          </div>
          <div class="personDetailSearchResults" data-panel-search-results="1"></div>
          <div class="personDetailSearchHint">Enter a name or ID (e.g. I0063).</div>
        </div>
        <button class="personDetailClose" type="button" data-panel-close="1" title="Close">×</button>
      </div>
    </div>
    <div class="personDetailTabs" role="tablist" aria-label="Person detail tabs">
      <button class="personDetailTab" type="button" data-tab="details">Details</button>
      <button class="personDetailTab" type="button" data-tab="relations">Relations</button>
      <button class="personDetailTab" type="button" data-tab="gramps_notes">Gramps Notes</button>
      <button class="personDetailTab" type="button" data-tab="media">Media</button>
      <button class="personDetailTab" type="button" data-tab="sources">Sources</button>
      <button class="personDetailTab" type="button" data-tab="other">Other</button>
      <button class="personDetailTab" type="button" data-tab="user_notes">User Notes</button>
    </div>
    <div class="personDetailBody" data-panel-body="1"></div>
    <div class="personDetailResizeHandle" data-panel-resize="1" title="Drag to resize"></div>
  `;

  const setActiveTab = (name) => {
    const tab = String(name || '').trim();
    if (!tab) return;
    state.detailPanel.activeTab = tab;
    for (const b of host.querySelectorAll('.personDetailTab[data-tab]')) {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    _renderPersonDetailPanelBody();
  };

  for (const b of host.querySelectorAll('.personDetailTab[data-tab]')) {
    b.addEventListener('click', () => setActiveTab(b.dataset.tab));
  }

  // Close button (use delegation so it still works if the click target is a text node)
  host.addEventListener('click', (e) => {
    const t = e?.target;
    const el = (t && t.nodeType === 1) ? t : t?.parentElement;
    const closeBtn = el && el.closest ? el.closest('[data-panel-close="1"]') : null;
    if (!closeBtn) return;
    hidePersonDetailPanel();
    e.preventDefault();
    e.stopPropagation();
  });

  // Search popover (in header)
  const getSearchEls = () => {
    const pop = host.querySelector('[data-panel-search-popover="1"]');
    return {
      pop,
      input: pop ? pop.querySelector('[data-panel-search-input="1"]') : null,
      results: pop ? pop.querySelector('[data-panel-search-results="1"]') : null,
    };
  };

  const closeSearch = () => {
    const { pop } = getSearchEls();
    if (!pop) return;
    try { pop.hidden = true; } catch (_) {}
    try { host.classList.remove('searchOpen'); } catch (_) {}
  };

  const openSearch = async () => {
    const { pop, input } = getSearchEls();
    if (!pop || !input) return;
    try { pop.hidden = false; } catch (_) {}
    try { host.classList.add('searchOpen'); } catch (_) {}
    try { await ensurePeopleIndexLoaded(); } catch (_) {}
    try { input.focus(); input.select(); } catch (_) {}
  };

  const renderSearchResults = (qRaw) => {
    const { results } = getSearchEls();
    if (!results) return;

    const q = String(qRaw || '').trim();
    const people = Array.isArray(state.people) ? state.people : [];
    if (!q) {
      results.innerHTML = '';
      return;
    }

    const qNorm = _normKey(q);
    const out = [];
    for (const p of people) {
      if (!p) continue;
      const gid = String(p?.gramps_id || '').trim();
      const pid = String(p?.id || '').trim();
      const name = String(p?.display_name || p?.name || '').trim();
      const given = String(p?.given_name || '').trim();
      const sur = String(p?.surname || '').trim();
      const hay = _normKey(`${gid} ${pid} ${name} ${given} ${sur}`);
      if (!hay.includes(qNorm)) continue;

      const by = (typeof p?.birth_year === 'number') ? p.birth_year : null;
      const dy = (typeof p?.death_year === 'number') ? p.death_year : null;
      out.push({
        apiId: pid || null,
        grampsId: gid || null,
        name: name || gid || pid,
        birthYear: by,
        deathYear: dy,
      });
      if (out.length >= 30) break;
    }

    if (!out.length) {
      results.innerHTML = '<div class="personDetailSearchEmpty">No matches.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const r of out) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'peopleItem personDetailSearchItem';
      b.dataset.personApiId = r.apiId || '';
      b.dataset.personGrampsId = r.grampsId || '';

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = r.name;

      const metaRow = document.createElement('div');
      metaRow.className = 'metaRow';

      // Always render dates for consistent alignment (matches People tab “expanded” layout).
      const datesBlock = document.createElement('span');
      datesBlock.className = 'datesBlock';

      const birthEl = document.createElement('span');
      birthEl.className = 'dateBirth';
      birthEl.textContent = (typeof r.birthYear === 'number' && Number.isFinite(r.birthYear)) ? String(r.birthYear) : '';

      const dashEl = document.createElement('span');
      dashEl.className = 'dateDash';
      const hasBirth = (r.birthYear !== null && r.birthYear !== undefined);
      const hasDeath = (r.deathYear !== null && r.deathYear !== undefined);
      dashEl.textContent = (hasBirth || hasDeath) ? ' - ' : '';

      const deathEl = document.createElement('span');
      deathEl.className = 'dateDeath';
      deathEl.textContent = (typeof r.deathYear === 'number' && Number.isFinite(r.deathYear)) ? String(r.deathYear) : '';

      datesBlock.appendChild(birthEl);
      datesBlock.appendChild(dashEl);
      datesBlock.appendChild(deathEl);
      metaRow.appendChild(datesBlock);

      const metaEl = document.createElement('span');
      metaEl.className = 'meta';
      metaEl.textContent = String(r.grampsId || r.apiId || '');
      metaRow.appendChild(metaEl);

      b.appendChild(nameEl);
      b.appendChild(metaRow);
      frag.appendChild(b);
    }
    results.innerHTML = '';
    results.appendChild(frag);
  };

  // Toggle + close/search click handlers (delegation)
  host.addEventListener('click', (e) => {
    const t = e?.target;
    const el = (t && t.nodeType === 1) ? t : t?.parentElement;
    if (!el) return;

    const searchBtn = el.closest ? el.closest('[data-panel-search="1"]') : null;
    const closeBtn = el.closest ? el.closest('[data-panel-search-close="1"]') : null;
    const itemBtn = el.closest ? el.closest('.personDetailSearchItem') : null;

    if (searchBtn) {
      const { pop } = getSearchEls();
      const open = !!(pop && !pop.hidden);
      Promise.resolve(open ? closeSearch() : openSearch()).catch(() => {});
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      return;
    }
    if (closeBtn) {
      closeSearch();
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      return;
    }
    if (itemBtn) {
      const apiId = String(itemBtn.dataset.personApiId || '').trim() || null;
      const grampsId = String(itemBtn.dataset.personGrampsId || '').trim() || null;
      selection.selectPerson({ apiId, grampsId }, { source: 'detail-search', scrollPeople: false, updateInput: true });
      // Match People-tab click behavior: treat this as a new seed and reload.
      Promise.resolve(loadNeighborhood()).catch(() => {});
      closeSearch();
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      return;
    }
  });

  // Search-as-you-type
  const { input: searchInput } = getSearchEls();
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      try { if (state.detailPanel.searchTimer) clearTimeout(state.detailPanel.searchTimer); } catch (_) {}
      state.detailPanel.searchTimer = setTimeout(() => {
        state.detailPanel.searchTimer = null;
        renderSearchResults(searchInput.value);
      }, 60);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSearch();
        try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      }
    });
  }

  // Close on outside click / Escape (wire once per host)
  if (!state.detailPanel.searchWired) {
    state.detailPanel.searchWired = true;
    document.addEventListener('click', (e) => {
      const { pop } = getSearchEls();
      if (!pop || pop.hidden) return;
      const t = e?.target;
      if (t && pop.contains(t)) return;
      closeSearch();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const { pop } = getSearchEls();
      if (!pop || pop.hidden) return;
      closeSearch();
    });
  }

  // Place link inside Event metadata (Details tab)
  host.addEventListener('click', (e) => {
    const t = e?.target;
    const el = (t && t.nodeType === 1) ? t : t?.parentElement;
    const link = el && el.closest ? el.closest('.eventPlaceLink[data-place-id]') : null;
    if (!link) return;

    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (_) {}

    const pid = String(link.dataset.placeId || '').trim();
    if (!pid) return;

    const name = String(link.dataset.placeName || '').trim();
    const lat = Number(link.dataset.placeLat);
    const lon = Number(link.dataset.placeLon);
    const gid = String(link.dataset.placeGrampsId || '').trim();

    const place = { id: pid, name: name || '' };
    if (gid) place.gramps_id = gid;
    if (Number.isFinite(lat)) place.lat = lat;
    if (Number.isFinite(lon)) place.lon = lon;

    try { _selectPlaceGlobal(place, { emitMapEvent: true }); } catch (_) {}
  });

  // Drag behavior
  const header = host.querySelector('[data-panel-drag="1"]');
  if (header) {
    header.addEventListener('pointerdown', (e) => {
      // Avoid starting a drag when clicking the close button.
      const t = e?.target;
      const el = (t && t.nodeType === 1) ? t : t?.parentElement;
      if (el && el.closest && el.closest('[data-panel-close="1"]')) return;
      if (el && el.closest && el.closest('[data-panel-search="1"]')) return;
      if (el && el.closest && el.closest('[data-panel-search-popover="1"]')) return;
      state.detailPanel.drag.active = true;
      const rect = host.getBoundingClientRect();
      state.detailPanel.drag.dx = (e.clientX - rect.left);
      state.detailPanel.drag.dy = (e.clientY - rect.top);
      try { header.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!state.detailPanel.drag.active) return;
      state.detailPanel.pos.left = e.clientX - state.detailPanel.drag.dx;
      state.detailPanel.pos.top = e.clientY - state.detailPanel.drag.dy;
      _applyDetailPanelPos();
    });

    const endDrag = () => {
      if (!state.detailPanel.drag.active) return;
      state.detailPanel.drag.active = false;
      _saveDetailPanelPos();
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  // Resize behavior (height)
  const resizeHandle = host.querySelector('[data-panel-resize="1"]');
  if (resizeHandle) {
    resizeHandle.addEventListener('pointerdown', (e) => {
      state.detailPanel.resize.active = true;
      state.detailPanel.resize.startY = e.clientY;
      state.detailPanel.resize.startH = host.offsetHeight || DETAIL_PANEL_DEFAULT_SIZE.h;
      try { resizeHandle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    resizeHandle.addEventListener('pointermove', (e) => {
      if (!state.detailPanel.resize.active) return;
      const dy = e.clientY - state.detailPanel.resize.startY;
      state.detailPanel.size.h = state.detailPanel.resize.startH + dy;
      _applyDetailPanelSize();
      _applyDetailPanelPos();
    });

    const endResize = () => {
      if (!state.detailPanel.resize.active) return;
      state.detailPanel.resize.active = false;
      _saveDetailPanelSize();
    };
    resizeHandle.addEventListener('pointerup', endResize);
    resizeHandle.addEventListener('pointercancel', endResize);
  }

  setActiveTab(state.detailPanel.activeTab || 'details');
}

function showPersonDetailPanel() {
  const host = els.personDetailPanel;
  if (!host) return;
  state.detailPanel.open = true;
  host.hidden = false;
  _setDetailPeekVisible(false);
  _applyDetailPanelSize();
  _applyDetailPanelPos();
}

function hidePersonDetailPanel() {
  const host = els.personDetailPanel;
  if (!host) return;
  state.detailPanel.open = false;
  host.hidden = true;
  _setDetailPeekVisible(true);
}

function _setPanelHeader({ name, meta, portraitUrl, gender } = {}) {
  const host = els.personDetailPanel;
  if (!host) return;
  const nameTextEl = host.querySelector('[data-person-name-text="1"]');
  const metaEl = host.querySelector('[data-person-meta="1"]');
  const avEl = host.querySelector('[data-person-avatar="1"]');
  if (nameTextEl) nameTextEl.textContent = String(name || 'Person');
  if (metaEl) metaEl.textContent = String(meta || '');

  if (avEl) {
    avEl.innerHTML = '';
    const url = String(portraitUrl || '').trim();
    // Keep a copy for the hidden-panel peek tab.
    state.detailPanel.peek.url = url;
    state.detailPanel.peek.name = String(name || '').trim();
    if (!state.detailPanel.open) {
      try { _setDetailPeekVisible(true); } catch (_) {}
    }
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      avEl.appendChild(img);
    }
  }

  // Gender icon (keep visible even when name is long)
  try {
    const gEl = host.querySelector('[data-person-gender="1"]');
    const icon = _genderIcon(gender);
    if (gEl) {
      gEl.textContent = icon.text;
      if (icon.title) gEl.setAttribute('title', icon.title);
      else gEl.removeAttribute('title');
    }
  } catch (_) {}
}

function _genderIcon(genderRaw) {
  const g = String(genderRaw || '').trim().toUpperCase();
  if (!g || g === 'U' || g === 'UNKNOWN' || g === '?') return { text: '', title: '' };
  if (g === 'M' || g === 'MALE') return { text: '♂', title: 'Male' };
  if (g === 'F' || g === 'FEMALE') return { text: '♀', title: 'Female' };
  // Any other value (custom/unknown): show a neutral marker.
  return { text: '•', title: 'Gender' };
}

function _renderKv(rows) {
  if (!rows || !rows.length) return '';
  const items = rows
    .filter(([, v]) => {
      if (v === null || v === undefined) return false;
      const s = String(v).trim();
      return s.length > 0;
    })
    .map(([k, v]) => `<div class="k">${_escapeHtml(k)}</div><div class="v">${_escapeHtml(v)}</div>`)
    .join('');
  return items ? `<div class="kv">${items}</div>` : '';
}

function _renderEvent(ev) {
  const t = String(ev?.type || 'Event');
  const role = String(ev?.role || '').trim();
  const dateText = String(ev?.date_text || '').trim();
  const dateIso = String(ev?.date || '').trim();
  const dateUi = formatGrampsDateEnglish(dateIso || dateText);
  const place = ev?.place || null;
  const placeId = String(place?.id || '').trim();
  const placeGrampsId = String(place?.gramps_id || '').trim();
  const placeName = _formatEventPlaceForSidebar(ev);
  const desc = String(ev?.description || '').trim();

  const metaHtmlParts = [];
  if (dateUi) metaHtmlParts.push(`<span class="eventMetaPart">${_escapeHtml(dateUi)}</span>`);
  if (placeName) {
    if (placeId) {
      const lat = Number(place?.lat);
      const lon = Number(place?.lon);
      const latAttr = Number.isFinite(lat) ? ` data-place-lat="${_escapeHtml(String(lat))}"` : '';
      const lonAttr = Number.isFinite(lon) ? ` data-place-lon="${_escapeHtml(String(lon))}"` : '';
      const gidAttr = placeGrampsId ? ` data-place-gramps-id="${_escapeHtml(placeGrampsId)}"` : '';
      metaHtmlParts.push(
        `<button type="button" class="eventPlaceLink" data-place-id="${_escapeHtml(placeId)}" data-place-name="${_escapeHtml(placeName)}"${gidAttr}${latAttr}${lonAttr} title="Select place">${_escapeHtml(placeName)}</button>`
      );
    } else {
      metaHtmlParts.push(`<span class="eventMetaPart">${_escapeHtml(placeName)}</span>`);
    }
  }
  const metaHtml = metaHtmlParts.join(' · ');

  const notes = Array.isArray(ev?.notes) ? ev.notes : [];
  const notesHtml = notes.length
    ? `<div class="personDetailSectionTitle">Event Notes</div><div class="noteList">${notes.map(n => `<div class="noteItem">${_escapeHtml(n?.body || '')}</div>`).join('')}</div>`
    : '';

  return `
    <div class="eventItem">
      <div class="eventHeader">
        <div class="eventTitle">${_escapeHtml(t)}</div>
        ${role ? `<div class="eventRole">${_escapeHtml(role)}</div>` : ''}
      </div>
      ${metaHtml ? `<div class="eventMeta">${metaHtml}</div>` : ''}
      ${desc ? `<div class="eventDesc">${_escapeHtml(desc)}</div>` : ''}
      ${notesHtml}
    </div>
  `;
}

function _selectPlaceGlobal(placeLike, { emitMapEvent = true } = {}) {
  const place = (typeof placeLike === 'string') ? { id: placeLike } : (placeLike || null);
  const pid = String(place?.id || '').trim();
  if (!pid) return;

  // If a different place becomes selected, close any open place-events panel.
  try {
    const openPid = String(state.placeEventsPanel?.placeId || '').trim();
    if (openPid && openPid !== pid) _closePlaceEventsPanel();
  } catch (_) {}

  state.placesSelected = pid;
  state.map.pendingPlaceId = pid;

  // Highlight in the Places list (if already rendered).
  try {
    if (els.placesList) {
      for (const el of els.placesList.querySelectorAll('.peopleItem.selected')) el.classList.remove('selected');
      const sel = els.placesList.querySelector(`.peopleItem.placesItem[data-place-id="${_cssEscape(pid)}"]`);
      if (sel) {
        sel.classList.add('selected');
        // Ensure ancestors are open so selection is visible.
        let d = sel.closest('details.placesGroup');
        while (d) {
          d.open = true;
          d = d.parentElement ? d.parentElement.closest('details.placesGroup') : null;
        }
        try { sel.scrollIntoView({ block: 'center' }); } catch (_) {}
      }
    }
  } catch (_) {}

  try {
    const label = _placeLabel(place);
    const meta = _placeMeta(place);
    setStatus(`Place: ${meta || pid} · ${label}`);
  } catch (_) {}

  if (emitMapEvent) {
    // Note: this should never force the map to become visible.
    try { window.dispatchEvent(new CustomEvent('relchart:place-selected', { detail: place })); } catch (_) {}
  }

  // Prime menu availability for this place.
  try { Promise.resolve(_ensurePlaceEventsLoaded(pid)).catch(() => {}); } catch (_) {}
}

function _resolveRelationsRootPersonId() {
  const direct = String(state.selectedPersonId || '').trim();
  if (direct) return direct;
  return _resolveSelectedPersonIdFromPayload(state.payload, selection);
}

function _formatBirthDeathLine(p) {
  const birth = formatGrampsDateEnglishCard((p?.birth || '').trim());
  const death = formatGrampsDateEnglishCard((p?.death || '').trim());
  const parts = [];
  if (birth) parts.push(`* ${birth}`);
  if (death) parts.push(`† ${death}`);
  return parts.join(' · ');
}

function _renderRelPersonButton(p, { roleLabel = '' } = {}) {
  if (!p?.id) return '';
  const apiId = String(p.id);
  const gid = String(p?.gramps_id || '').trim();
  const name = String(p?.display_name || gid || apiId || 'Person');
  const dates = _formatBirthDeathLine(p);
  const role = String(roleLabel || '').trim();
  return `
    <button class="relPerson" type="button" data-rel-api="${_escapeHtml(apiId)}" data-rel-gramps="${_escapeHtml(gid)}">
      <div class="relPersonTop">
        <div class="relPersonName">${_escapeHtml(name)}</div>
        ${role ? `<div class="relPersonRole">${_escapeHtml(role)}</div>` : ''}
      </div>
      ${dates ? `<div class="relPersonDates">${_escapeHtml(dates)}</div>` : ''}
    </button>
  `;
}

function _buildRelationsFromPayload(personApiId) {
  const pid = String(personApiId || '').trim();
  const payload = state.payload;
  if (!pid || !payload) return null;

  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  const peopleById = new Map(nodes.filter(n => n?.type === 'person' && n?.id).map(n => [String(n.id), n]));
  const familyById = new Map(nodes.filter(n => n?.type === 'family' && n?.id).map(n => [String(n.id), n]));
  const parentsByFamily = new Map(); // fid -> [pid]
  const childrenByFamily = new Map(); // fid -> [pid]
  const originFamilyIds = new Set();
  const spouseFamilyIds = new Set();

  for (const e of edges) {
    const t = String(e?.type || '').trim();
    if (t === 'parent') {
      const from = String(e?.from || '').trim();
      const to = String(e?.to || '').trim();
      if (!from || !to) continue;
      if (!parentsByFamily.has(to)) parentsByFamily.set(to, []);
      parentsByFamily.get(to).push(from);
      if (from === pid) spouseFamilyIds.add(to);
    } else if (t === 'child') {
      const from = String(e?.from || '').trim();
      const to = String(e?.to || '').trim();
      if (!from || !to) continue;
      if (!childrenByFamily.has(from)) childrenByFamily.set(from, []);
      childrenByFamily.get(from).push(to);
      if (to === pid) originFamilyIds.add(from);
    }
  }

  const uniq = (arr) => {
    const out = [];
    const seen = new Set();
    for (const x of arr || []) {
      const k = String(x || '').trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };

  const parents = [];
  for (const fid of originFamilyIds) {
    for (const parentId of (parentsByFamily.get(fid) || [])) {
      if (!parentId || parentId === pid) continue;
      const p = peopleById.get(String(parentId));
      if (p) parents.push(p);
    }
  }

  const siblings = [];
  for (const fid of originFamilyIds) {
    for (const sibId of (childrenByFamily.get(fid) || [])) {
      if (!sibId || sibId === pid) continue;
      const p = peopleById.get(String(sibId));
      if (p) siblings.push(p);
    }
  }

  const families = [];
  for (const fid of spouseFamilyIds) {
    const spouseIds = (parentsByFamily.get(fid) || []).filter(x => String(x) !== pid);
    const childIds = childrenByFamily.get(fid) || [];
    const famNode = familyById.get(String(fid)) || null;
    families.push({
      familyId: fid,
      familyGrampsId: famNode ? (String(famNode?.gramps_id || '').trim() || null) : null,
      marriage: famNode ? (String(famNode?.marriage || '').trim() || null) : null,
      spouses: uniq(spouseIds).map(id => peopleById.get(String(id))).filter(Boolean),
      children: uniq(childIds).map(id => peopleById.get(String(id))).filter(Boolean),
    });
  }

  const sortPeople = (arr) => {
    const a = Array.isArray(arr) ? arr.slice() : [];
    a.sort((p1, p2) => {
      const n1 = String(p1?.display_name || '').toLowerCase();
      const n2 = String(p2?.display_name || '').toLowerCase();
      return n1.localeCompare(n2);
    });
    return a;
  };

  return {
    person: peopleById.get(pid) || null,
    parents: sortPeople(uniq(parents.map(p => String(p.id))).map(id => peopleById.get(id)).filter(Boolean)),
    siblings: sortPeople(uniq(siblings.map(p => String(p.id))).map(id => peopleById.get(id)).filter(Boolean)),
    families: families.map(f => ({
      ...f,
      spouses: sortPeople(f.spouses),
      children: sortPeople(f.children),
    })),
  };
}

function _renderRelationsTab() {
  const pid = _resolveRelationsRootPersonId();
  if (!pid || !state.payload) {
    return '<div class="muted">Load a graph to view relations.</div>';
  }

  const rel = _buildRelationsFromPayload(pid);
  if (!rel) return '<div class="muted">No relations available.</div>';

  const originHtml = `
    <div class="personDetailSectionTitle">Parents & Siblings</div>
    <div class="relBox">
      <div class="relBoxHeader">
        <div class="relBoxTitle">Parents</div>
      </div>
      ${rel.parents?.length
        ? `<div class="relList">${rel.parents.map(p => _renderRelPersonButton(p, { roleLabel: 'parent' })).join('')}</div>`
        : `<div class="muted">None in view.</div>`}

      <div class="relIndented">
        <div class="relIndentedHeader">Siblings</div>
        ${rel.siblings?.length
          ? `<div class="relList">${rel.siblings.map(p => _renderRelPersonButton(p, { roleLabel: 'sibling' })).join('')}</div>`
          : `<div class="muted">None in view.</div>`}
      </div>
    </div>
  `;

  const famHtml = rel.families?.length
    ? `<div class="personDetailSectionTitle">Families</div>${rel.families.map((f) => {
        const spouses = (f.spouses || []);
        const kids = (f.children || []);
        const spousesHtml = spouses.length
          ? `<div class="relList relSpouseList">${spouses.map(s => _renderRelPersonButton(s, { roleLabel: 'spouse' })).join('')}</div>`
          : `<div class="muted">No partner in view.</div>`;

        const kidsHtml = kids.length
          ? `<div class="relList">${kids.map(c => _renderRelPersonButton(c, { roleLabel: 'child' })).join('')}</div>`
          : `<div class="muted">No children in view.</div>`;
        return `
          <div class="relFamily">
            <div class="relFamilyHeader">
              <div class="relFamilyTitle">${(() => {
                const m = String(f?.marriage || '').trim();
                const dm = m ? formatGrampsDateEnglishCard(m) : '';
                return _escapeHtml(dm ? `Spouse · ${dm}` : 'Spouse');
              })()}</div>
              <div class="relFamilyMeta">${_escapeHtml(String(f.familyGrampsId || f.familyId || ''))}</div>
            </div>
            ${spousesHtml}
            <div class="relChildrenIndented">
              <div class="relChildrenHeader">Children</div>
              ${kidsHtml}
            </div>
          </div>
        `;
      }).join('')}`
    : `<div class="personDetailSectionTitle">Families</div><div class="muted">None in view.</div>`;

  return `${originHtml}${famHtml}`;
}

function _wireRelationsClicks(hostEl) {
  const host = hostEl;
  if (!host) return;
  for (const btn of host.querySelectorAll('button.relPerson[data-rel-api]')) {
    btn.addEventListener('click', async () => {
      const apiId = String(btn.dataset.relApi || '').trim();
      const gid = String(btn.dataset.relGramps || '').trim();
      const ref = gid || apiId;
      if (!ref) return;

      // Behave like a global person selection, but do not force sidebar tab switches.
      const activeTab = _getSidebarActiveTab();
      selection.selectPerson(
        { apiId: apiId || null, grampsId: gid || null },
        { source: 'relations', scrollPeople: activeTab === 'people', updateInput: true },
      );
      if (!gid && apiId) {
        try { els.personId.value = apiId; } catch (_) {}
      }
      await loadNeighborhood();
    });
  }
}

function _eventTypeRank(typeRaw) {
  const t = String(typeRaw || '').trim().toLowerCase();
  if (!t) return 99;
  // Preferred order: birth, baptism, death, burial, marriage.
  // Use word-ish matching to handle common variants.
  if (/\bbirth\b/.test(t)) return 0;
  if (/\bbaptis|\bchristen/.test(t)) return 1;
  if (/\bdeath\b/.test(t)) return 2;
  if (/\bburial\b|\bbury\b|\bcremat/.test(t)) return 3;
  if (/\bmarriage\b|\bwedding\b/.test(t)) return 4;
  return 99;
}

function _sortEventsForPanel(events) {
  const src = Array.isArray(events) ? events : [];
  // Stable: keep original order within the same rank.
  return src
    .map((ev, idx) => ({ ev, idx, rank: _eventTypeRank(ev?.type) }))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
    .map(x => x.ev);
}

function _renderPersonDetailPanelBody() {
  const host = els.personDetailPanel;
  if (!host) return;
  const body = host.querySelector('[data-panel-body="1"]');
  if (!body) return;

  const data = state.detailPanel.data || null;
  const tab = String(state.detailPanel.activeTab || 'details');
  if (!data) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    return;
  }

  if (tab === 'details') {
    const events = Array.isArray(data.events) ? data.events : [];
    const eventsSorted = _sortEventsForPanel(events);
    const evHtml = events.length
      ? `<div class="personDetailSectionTitle">Events</div><div class="eventList">${eventsSorted.map(_renderEvent).join('')}</div>`
      : '';

    body.innerHTML = `
      ${evHtml || '<div class="muted">No events available.</div>'}
    `;
    return;
  }

  if (tab === 'relations') {
    body.innerHTML = _renderRelationsTab();
    try { _wireRelationsClicks(body); } catch (_) {}
    return;
  }

  if (tab === 'gramps_notes') {
    const notes = Array.isArray(data.gramps_notes) ? data.gramps_notes : [];
    body.innerHTML = notes.length
      ? `<div class="noteList">${notes.map(n => `<div class="noteItem">${_escapeHtml(n?.body || '')}</div>`).join('')}</div>`
      : '<div class="muted">No Gramps notes.</div>';
    return;
  }

  if (tab === 'user_notes') {
    body.innerHTML = '<div class="muted">User notes coming soon.</div>';
    return;
  }

  if (tab === 'media') {
    body.innerHTML = '<div class="muted">Media list coming soon.</div>';
    return;
  }

  if (tab === 'sources') {
    body.innerHTML = '<div class="muted">Source citations coming soon.</div>';
    return;
  }

  body.innerHTML = '<div class="muted">More tabs coming soon.</div>';
}

async function loadPersonDetailsIntoPanel(personApiId, { openPanel = false } = {}) {
  const pid = String(personApiId || '').trim();
  if (!pid) return;

  // Never auto-open the panel; only open if explicitly requested.
  if (openPanel) showPersonDetailPanel();

  const seq = (state.detailPanel.lastReqSeq || 0) + 1;
  state.detailPanel.lastReqSeq = seq;
  state.detailPanel.lastPersonId = pid;
  state.detailPanel.data = null;

  // Keep the hidden peek tab blank while loading.
  state.detailPanel.peek.loading = true;
  state.detailPanel.peek.url = '';
  state.detailPanel.peek.name = '';
  if (!state.detailPanel.open) {
    try { _updateDetailPeekTab(); } catch (_) {}
  }

  _setPanelHeader({ name: 'Loading…', meta: pid, gender: null });
  _renderPersonDetailPanelBody();

  try {
    const r = await fetch(`/people/${encodeURIComponent(pid)}/details`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (state.detailPanel.lastReqSeq !== seq) return;
    state.detailPanel.data = data;

    state.detailPanel.peek.loading = false;

    const p = data?.person || {};
    const name = String(p.display_name || 'Person');
    const metaParts = [];
    if (p.gramps_id) metaParts.push(String(p.gramps_id));
    _setPanelHeader({ name, meta: metaParts.join(' · '), portraitUrl: p.portrait_url, gender: p.gender });
    _renderPersonDetailPanelBody();
  } catch (e) {
    if (state.detailPanel.lastReqSeq !== seq) return;
    state.detailPanel.data = { person: { display_name: 'Error' } };

    state.detailPanel.peek.loading = false;
    _setPanelHeader({ name: 'Failed to load', meta: String(e?.message || e), gender: null });
    _renderPersonDetailPanelBody();
  }
}

const PEOPLE_EXPANDED_KEY = 'tree_relchart_people_expanded_v1';
const PEOPLE_WIDE_PX_KEY = 'tree_relchart_people_wide_px_v1';
const PEOPLE_WIDE_PX_DEFAULT = 440;

function _setPeopleWidePx(px, { persist = true } = {}) {
  let n = Number(px);
  if (!Number.isFinite(n)) return;
  n = Math.round(n);
  n = Math.max(360, Math.min(900, n));
  document.documentElement.style.setProperty('--sidebar-w-wide', `${n}px`);
  if (els.peopleWidth) els.peopleWidth.value = String(n);
  if (persist) {
    try { localStorage.setItem(PEOPLE_WIDE_PX_KEY, String(n)); } catch (_) {}
  }
}

function _setPeopleExpanded(expanded, { persist = true, rerender: shouldRerender = true } = {}) {
  const on = !!expanded;
  state.peopleExpanded = on;
  document.documentElement.dataset.peopleWide = on ? 'true' : 'false';
  if (els.peopleExpandToggle) {
    els.peopleExpandToggle.textContent = on ? 'Compact' : 'Expand';
    els.peopleExpandToggle.title = on ? 'Collapse people list' : 'Expand people list (show years)';
  }
  if (persist) {
    try { localStorage.setItem(PEOPLE_EXPANDED_KEY, on ? '1' : '0'); } catch (_) {}
  }
  if (shouldRerender && state.peopleLoaded && state.people) {
    _renderPeopleList(state.people, els.peopleSearch?.value || '');
  }
}

function _initPeopleExpanded() {
  let on = false;
  try {
    const v = String(localStorage.getItem(PEOPLE_EXPANDED_KEY) || '').trim();
    on = (v === '1' || v.toLowerCase() === 'true');
  } catch (_) {}

  let px = PEOPLE_WIDE_PX_DEFAULT;
  try {
    const raw = String(localStorage.getItem(PEOPLE_WIDE_PX_KEY) || '').trim();
    const n = Number(raw);
    if (Number.isFinite(n)) px = n;
  } catch (_) {}
  _setPeopleWidePx(px, { persist: false });

  if (els.optPeopleWidePx) {
    els.optPeopleWidePx.value = String(px);
    els.optPeopleWidePx.addEventListener('change', () => {
      _setPeopleWidePx(els.optPeopleWidePx.value);
      if (state.peopleExpanded && state.peopleLoaded && state.people) {
        _renderPeopleList(state.people, els.peopleSearch?.value || '');
      }
    });
  }

  // Close the menu when clicking outside.
  if (els.optionsMenu) {
    try {
      els.optionsMenu.addEventListener('toggle', () => {
        if (els.optionsMenu.open) _portalDetailsPanel(els.optionsMenu, '.optionsPanel', { align: 'right' });
        else _unportalDetailsPanel(els.optionsMenu);
      });
    } catch (_) {}

    document.addEventListener('click', (e) => {
      const open = els.optionsMenu.open;
      if (!open) return;
      const t = e.target;
      if (t && _isInsideDetailsOrPortal(els.optionsMenu, t)) return;
      els.optionsMenu.open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        try { els.optionsMenu.open = false; } catch (_) {}
      }
    });
  }

  _setPeopleExpanded(on, { persist: false, rerender: false });
  if (els.peopleExpandToggle) {
    els.peopleExpandToggle.addEventListener('click', () => {
      _setPeopleExpanded(!state.peopleExpanded);
    });
  }
}

function _setSidebarActiveTab(tabName) {
  const name = String(tabName || '').trim();
  if (!name) return;

  // Place-events popover is Map-tab-only.
  try {
    if (name !== 'map') _closePlaceEventsPanel();
  } catch (_) {}

  const tabButtons = Array.from(document.querySelectorAll('.tabbtn[data-tab]'));
  const tabPanels = Array.from(document.querySelectorAll('.tabpanel[data-panel]'));
  for (const b of tabButtons) {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const p of tabPanels) {
    p.classList.toggle('active', p.dataset.panel === name);
  }

  // Main viewport: show map only for the Map tab; otherwise show graph.
  try {
    _setMainView(name === 'map' ? 'map' : 'graph');
    _setTopbarControlsMode(name === 'map' ? 'map' : 'graph');

    // Map-only UI and overlays.
    if (name !== 'map') {
      _closeMapPopovers();
      _setMapOverlaysVisible(false);

      try {
        const cur = String(els.status?.textContent || '').trim();
        if (/^map\s*:/i.test(cur)) {
          setStatus(state.status.lastNonMapMsg, state.status.lastNonMapIsError);
        }
      } catch (_) {}
    }

    if (name === 'map') {
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
            const p = _resolvePlaceForMap(pid);
            _centerMapOnPlace(p);
          }
        } catch (_) {}
      });
    }
  } catch (_) {}

  // Lazy-load + scroll-to-selection on explicit tab open.
  // (Selection changes elsewhere should not force the sidebar to switch tabs.)
  try {
    if (name === 'people') {
      Promise.resolve(ensurePeopleLoaded()).then(() => {
        try { _applyPeopleSelectionToDom({ scroll: true }); } catch (_) {}
      });
    }
    if (name === 'families') {
      Promise.resolve(ensureFamiliesLoaded()).then(() => {
        // Fresh page loads often have a selected person but no selected family yet.
        // When opening Families, pick a relevant family for the selected person so
        // the list highlights immediately.
        try {
          if (!state.familiesSelected) {
            const cur = selection?.get?.() || {};
            if (cur?.apiId) _selectParentFamilyForPersonInSidebar(cur.apiId);
          }
        } catch (_) {}
        try { _applyFamiliesSelectionToDom({ scroll: true }); } catch (_) {}
      });
    }

    if (name === 'events') {
      Promise.resolve(ensureEventsLoaded()).then(() => {
        // Nothing else to sync yet.
      });
    }

    if (name === 'map') {
      Promise.resolve(ensurePlacesLoaded()).then(() => {
        // Now that places are loaded, upgrade any pending selection so the map can center.
        try {
          const pid = String(state.map.pendingPlaceId || state.placesSelected || '').trim();
          if (pid && state.map.map && els.chart?.dataset?.mainView === 'map') {
            const p = _resolvePlaceForMap(pid);
            _centerMapOnPlace(p);
          }
        } catch (_) {}

        // Ensure the selected place is visible in the Places tree.
        try { _applyPlacesSelectionToDom({ scroll: true }); } catch (_) {}
      });
    }
  } catch (_) {}
}

// Allow the HTML shell to delegate tab switching to app.js so lazy-loading
// (people/families/events/places) actually triggers.
try {
  window.relchartSetSidebarActiveTab = _setSidebarActiveTab;
  window.relchartGetSidebarActiveTab = _getSidebarActiveTab;
} catch (_) {}

function _getSidebarActiveTab() {
  const b = document.querySelector('.tabbtn.active[data-tab]');
  const t = String(b?.dataset?.tab || '').trim();
  return t || null;
}

function _normPlaceType(raw) {
  const s = String(raw || '').trim();
  return s;
}

function _normalizePlaceNameDisplay(rawName) {
  const raw = String(rawName || '').trim();
  if (!raw) return '';

  // If the string is already mixed-case (has both upper and lower), assume the user intended it.
  // Only normalize when it's obviously wrong (ALL CAPS / all lowercase).
  const hasLower = /\p{Ll}/u.test(raw);
  const hasUpper = /\p{Lu}/u.test(raw);
  if (hasLower && hasUpper) return raw;

  const lowerWords = new Set([
    'van', 'de', 'den', 'der', 'het', 'een',
    'aan', 'op', 'in', 'bij', 'te', 'ten', 'ter',
    'aan', 'voor', 'achter', 'onder', 'boven',
    'en', 'of',
    "'t",
  ]);

  const capFirst = (s) => {
    const v = String(s || '');
    if (!v) return v;
    return v.charAt(0).toUpperCase() + v.slice(1);
  };

  const capWord = (word, isFirstWord) => {
    const w = String(word || '');
    if (!w) return w;

    // Preserve pure punctuation/number tokens.
    if (!/[\p{L}]/u.test(w)) return w;

    // Handle common Dutch contractions/prefixes.
    // Example: "'s-gravenzande" => "'s-Gravenzande"
    const lower = w.toLowerCase();
    if (lower.startsWith("'s-")) {
      const rest = w.slice(3).toLowerCase();
      const parts = rest.split('-').map((p) => capFirst(p));
      return "'s-" + parts.join('-');
    }
    if (lower === "'s") return "'s";
    if (lower === "'t") return "'t";

    // Handle hyphenated words: title-case each segment.
    const segs = lower.split('-');
    const fixed = segs.map((seg, idx) => {
      const s = String(seg || '');
      if (!s) return s;
      // Keep particles lowercased unless it's the first overall word.
      if (!isFirstWord && idx === 0 && lowerWords.has(s)) return s;
      return capFirst(s);
    });
    const joined = fixed.join('-');

    // Keep particles lowercased unless first word.
    if (!isFirstWord && lowerWords.has(joined)) return joined;
    return joined;
  };

  // Normalize whitespace but preserve the original separators between tokens.
  const tokens = raw.split(/\s+/).filter(Boolean);
  const out = tokens.map((tok, i) => capWord(tok, i === 0));
  return out.join(' ');
}

function _placeLabel(p) {
  const raw = String(p?.name || '').trim();
  const fixed = _normalizePlaceNameDisplay(raw);
  return fixed || '(unnamed place)';
}

function _placeMeta(p) {
  const t = _normPlaceType(p?.type);
  const gid = String(p?.gramps_id || '').trim();
  const parts = [];
  if (t) parts.push(t);
  if (gid) parts.push(gid);
  return parts.join(', ');
}

function _placeTypeText(p) {
  return _normPlaceType(p?.type);
}

function _placeIdText(p) {
  return String(p?.gramps_id || '').trim();
}

function _isLikelyInNetherlands(p) {
  const lat = Number(p?.lat);
  const lon = Number(p?.lon);
  // Rough NL bounding box (WGS84). Using a generous box avoids false negatives.
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return lat >= 50.6 && lat <= 53.8 && lon >= 2.7 && lon <= 7.5;
  }
  // If we have no coordinates, fall back to name heuristics.
  const n = _placeLabel(p).toLowerCase();
  return n.includes('netherlands') || n.includes('nederland');
}

function _isCountryPlace(p) {
  const t = _normPlaceType(p?.type).toLowerCase();
  if (!t) return false;
  return t === 'country' || t === 'land' || t === 'nation';
}

function _isLikelyCountryName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  // Small pragmatic list: keep other countries top-level even if place_type is missing.
  // (Common in exports where only name + coordinates were filled.)
  const known = new Set([
    'netherlands',
    'nederland',
    'belgium',
    'belgië',
    'belgie',
    'germany',
    'duitsland',
    'france',
    'frankrijk',
    'england',
    'united kingdom',
    'uk',
    'scotland',
    'ireland',
    'united states',
    'usa',
    'indonesia',
    'nederlands-indie',
    'nederlands-indië',
    'italy',
    'italie',
    'italië',
    'israel',
    'hungary',
    'hongarije',
  ]);
  return known.has(n);
}

function _isCountryPlaceRobust(p) {
  if (_isCountryPlace(p)) return true;
  const parent = String(p?.enclosed_by_id || '').trim();
  if (parent) return false;
  return _isLikelyCountryName(p?.name);
}

function _countryNameForCoords(latRaw, lonRaw) {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // Rough country bounding boxes (WGS84). These are pragmatic buckets.
  // Order matters: check NL before broader neighbors.
  if (lat >= 50.6 && lat <= 53.8 && lon >= 2.7 && lon <= 7.5) return 'netherlands';
  if (lat >= 49.4 && lat <= 51.6 && lon >= 2.4 && lon <= 6.5) return 'belgium';
  if (lat >= 47.2 && lat <= 55.2 && lon >= 5.2 && lon <= 15.6) return 'germany';
  if (lat >= 41.0 && lat <= 51.6 && lon >= -5.5 && lon <= 9.8) return 'france';
  if (lat >= 35.0 && lat <= 48.0 && lon >= 6.0 && lon <= 19.5) return 'italy';
  if (lat >= 29.0 && lat <= 34.2 && lon >= 34.0 && lon <= 36.5) return 'israel';
  if (lat >= 45.6 && lat <= 48.7 && lon >= 16.0 && lon <= 22.9) return 'hungary';
  return null;
}

function _ensureCountryRoot(byId, rootCountries, countryKey) {
  const key = String(countryKey || '').trim().toLowerCase();
  if (!key) return null;

  const aliases = {
    netherlands: new Set(['netherlands', 'nederland']),
    belgium: new Set(['belgium', 'belgie', 'belgië']),
    germany: new Set(['germany', 'duitsland']),
    france: new Set(['france', 'frankrijk']),
    italy: new Set(['italy', 'italie', 'italië']),
    israel: new Set(['israel']),
    hungary: new Set(['hungary', 'hongarije']),
  };

  const match = (p) => {
    const label = _placeLabel(p).toLowerCase();
    const a = aliases[key];
    if (a && a.has(label)) return true;
    return label === key;
  };

  const existing = Array.isArray(rootCountries) ? rootCountries.find(match) : null;
  if (existing) return String(existing.id);

  const id = `__country_${key.replace(/[^a-z0-9]+/g, '_')}__`;
  if (!byId.has(id)) {
    const title = key.charAt(0).toUpperCase() + key.slice(1);
    byId.set(id, { id, gramps_id: null, name: title, type: 'Country', enclosed_by_id: null });
  }
  const rec = byId.get(id);
  if (rec && !rootCountries.some((p) => String(p?.id || '') === id)) rootCountries.push(rec);
  return id;
}

function _renderPlacesTreeNode(node, byId, childrenByParent, opts) {
  const { depth, queryNorm, matchedIds, onSelect } = opts;
  const children = childrenByParent.get(node.id) || [];
  const hasChildren = children.length > 0;

  const INDENT_PX = 18;

  const _placeBreadcrumb = () => {
    const enclosure = Array.isArray(node?.enclosure) ? node.enclosure : [];
    const anc = enclosure
      .map((e) => String(e?.name || '').trim())
      .filter((s) => s)
      // API provides nearest-parent-first; reverse for root-first.
      .reverse();
    const self = _placeLabel(node);
    return [...anc, self].filter((s) => s).join(' > ');
  };

  const _copyText = async (text) => {
    const t = String(text || '');
    if (!t) return false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (_) {}
    // Fallback for older browsers.
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) {
      return false;
    }
  };

  const selectThisPlace = (rowEl, { emitMapEvent = true } = {}) => {
    const pid = String(node.id || '').trim();
    if (!pid) return;

    // If a different place becomes selected, close any open place-events panel.
    try {
      const openPid = String(state.placeEventsPanel?.placeId || '').trim();
      if (openPid && openPid !== pid) _closePlaceEventsPanel();
    } catch (_) {}

    state.placesSelected = pid;
    state.map.pendingPlaceId = pid;
    try {
      if (els.placesList) {
        for (const el of els.placesList.querySelectorAll('.peopleItem.selected')) el.classList.remove('selected');
      }
      rowEl.classList.add('selected');
    } catch (_) {}
    try { setStatus(`Place: ${_placeMeta(node) || pid} · ${_placeLabel(node)}`); } catch (_) {}
    if (emitMapEvent) {
      try { onSelect && onSelect(node); } catch (_) {}
    }

    // Prime the cache so opening the panel is instant if the user clicks the menu.
    try { Promise.resolve(_ensurePlaceEventsLoaded(pid)).catch(() => {}); } catch (_) {}
  };

  const buildRow = (elTag) => {
    const rowEl = document.createElement(elTag);
    rowEl.className = 'peopleItem placesItem';
    rowEl.dataset.placeId = String(node.id || '');
    if (state.placesSelected && String(state.placesSelected) === String(node.id)) rowEl.classList.add('selected');

    const grid = document.createElement('div');
    grid.className = 'placeGrid';

    const left = document.createElement('div');
    left.className = 'placeLeft';
    const d = Number(depth || 0);
    if (d > 0) left.style.paddingLeft = `${d * INDENT_PX}px`;

    const nameRow = document.createElement('div');
    nameRow.className = 'placeNameRow';

    const twisty = document.createElement('span');
    twisty.className = hasChildren ? 'placesTwisty' : 'placesTwistySpacer';
    twisty.setAttribute('aria-hidden', 'true');
    twisty.textContent = hasChildren ? '▶' : '';
    nameRow.appendChild(twisty);

    const name = document.createElement('span');
    name.className = 'placeName';
    name.textContent = _placeLabel(node);
    name.title = name.textContent;
    // Clicking the name centers the map (if coords exist) AND copies ID + full breadcrumb.
    name.addEventListener('click', async (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (_) {}

      // Keep expand/collapse on the row box, not the text.
      // But the text click should still behave like a “select this place”.
      try { selectThisPlace(rowEl, { emitMapEvent: true }); } catch (_) {}

      const gid = String(node?.gramps_id || '').trim();
      const internal = String(node?.id || '').trim();
      const idPart = gid ? `${gid} (${internal})` : internal;
      const crumb = _placeBreadcrumb();
      const text = `${idPart}\t${crumb}`;
      const ok = await _copyText(text);
      try { setStatus(ok ? `Copied: ${idPart} · ${crumb}` : 'Copy failed.'); } catch (_) {}
    });
    nameRow.appendChild(name);

    left.appendChild(nameRow);

    const right = document.createElement('div');
    right.className = 'placeMetaRight';

    const typeText = _placeTypeText(node);
    if (typeText) {
      const typeEl = document.createElement('div');
      typeEl.className = 'placeTypeRight';
      typeEl.textContent = typeText;
      right.appendChild(typeEl);
    }

    const gid = _placeIdText(node);
    const idRow = document.createElement('div');
    idRow.className = 'placeIdRow';

    const idEl = document.createElement('div');
    idEl.className = 'placeIdRight';
    idEl.textContent = gid;
    idRow.appendChild(idEl);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'placeEventsMenuBtn';
    menuBtn.title = 'Show events for this place';
    menuBtn.setAttribute('aria-label', 'Show events for this place');
    menuBtn.dataset.placeId = String(node.id || '');
    menuBtn.innerHTML = '<span class="placesMenuIcon" aria-hidden="true"></span>';

    // Visibility is driven by per-place counts loaded once.
    // If counts aren't loaded yet, keep hidden; we'll flip visibility once counts arrive.
    const count = Number(state.placeEventCountById?.get?.(String(node.id)));
    const has = Number.isFinite(count) && count > 0;
    menuBtn.style.visibility = has ? 'visible' : 'hidden';

    menuBtn.addEventListener('click', (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (_) {}
      try { _togglePlaceEventsPanel(String(node.id || ''), menuBtn); } catch (_) {}
    });

    idRow.appendChild(menuBtn);
    right.appendChild(idRow);

    grid.appendChild(left);
    grid.appendChild(right);
    rowEl.appendChild(grid);

    return rowEl;
  };

  if (!hasChildren) {
    const btn = buildRow('button');
    btn.type = 'button';
    // Clicking the row selects/highlights, but should not move the map.
    btn.addEventListener('click', () => selectThisPlace(btn, { emitMapEvent: false }));
    return btn;
  }

  const details = document.createElement('details');
  details.className = 'placesGroup';

  const summary = buildRow('summary');
  summary.addEventListener('click', () => {
    // Row click toggles the <details> (native behavior). Selecting is OK,
    // but should not move the map.
    selectThisPlace(summary, { emitMapEvent: false });
  });

  // Default open when searching and the subtree contains a match.
  if (queryNorm) {
    const open = matchedIds.has(String(node.id)) || children.some((c) => matchedIds.has(String(c.id)));
    if (open) details.open = true;
  }

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'placesChildren';
  for (const ch of children) {
    childrenWrap.appendChild(
      _renderPlacesTreeNode(byId.get(ch.id) || ch, byId, childrenByParent, {
        depth: depth + 1,
        queryNorm,
        matchedIds,
        onSelect,
      })
    );
  }

  details.appendChild(summary);
  details.appendChild(childrenWrap);
  return details;
}

function _computePlaceMatches(roots, byId, childrenByParent, queryNorm) {
  const matched = new Set();
  if (!queryNorm) return matched;

  const selfMatches = (p) => {
    const name = _placeLabel(p);
    const gid = String(p?.gramps_id || '').trim();
    const t = _normPlaceType(p?.type);
    return _normKey(`${name} ${gid} ${t}`).includes(queryNorm);
  };

  const walk = (nodeId) => {
    const node = byId.get(nodeId);
    if (!node) return false;
    let any = selfMatches(node);
    const kids = childrenByParent.get(nodeId) || [];
    for (const k of kids) {
      if (walk(k.id)) any = true;
    }
    if (any) matched.add(String(nodeId));
    return any;
  };

  for (const r of roots) walk(r.id);
  return matched;
}

function _renderPlacesList(allPlaces) {
  if (!els.placesList || !els.placesStatus) return;

  // Re-rendering the list invalidates anchors; close any open popover.
  try { _closePlaceEventsPanel(); } catch (_) {}

  const places = Array.isArray(allPlaces) ? allPlaces : [];
  const byId = new Map(places.map((p) => [String(p.id), p]));

  // Build child map.
  const childrenByParent = new Map();
  const roots = [];
  for (const p of places) {
    const pid = String(p?.id || '').trim();
    if (!pid) continue;
    const parent = String(p?.enclosed_by_id || '').trim();
    if (parent && byId.has(parent)) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push({ id: pid });
    } else {
      roots.push({ id: pid });
    }
  }

  // Alphabetical ordering by place label (stable tie-breaks).
  const sortKey = (p) => {
    if (!p) return '\uffff';
    const label = _placeLabel(p);
    const norm = _normKey(label);
    const gid = String(p?.gramps_id || '').trim();
    const pid = String(p?.id || '').trim();
    // Use NUL separators to avoid accidental key collisions.
    return `${norm}\u0000${label}\u0000${gid}\u0000${pid}`;
  };
  const sortChildren = (parentId) => {
    const kids = childrenByParent.get(parentId) || [];
    kids.sort((a, b) => sortKey(byId.get(a.id)).localeCompare(sortKey(byId.get(b.id))));
    for (const k of kids) sortChildren(k.id);
  };

  // Country normalization: keep countries as top-level roots.
  // When hierarchy is incomplete (no enclosed_by_id), bucket non-country roots
  // under a likely country (by coords when present; NL by default when missing)
  // so they don't appear as random top-level roots.
  const rootsResolved = roots.map((r) => byId.get(r.id)).filter(Boolean);
  const rootCountries = rootsResolved.filter(_isCountryPlaceRobust);
  const rootNonCountries = rootsResolved.filter((p) => !_isCountryPlaceRobust(p));

  const nlId = _ensureCountryRoot(byId, rootCountries, 'netherlands') || '__country_netherlands__';

  const unbucketedOrphans = [];
  for (const p of rootNonCountries) {
    const pid = String(p?.id || '').trim();
    if (!pid) continue;

    const lat = Number(p?.lat);
    const lon = Number(p?.lon);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    // Bucket by country bbox when possible.
    const bucketByCoords = _countryNameForCoords(lat, lon);
    const bucket = bucketByCoords || (hasCoords ? null : 'netherlands');
    if (!bucket) {
      unbucketedOrphans.push({ id: pid });
      continue;
    }

    const countryId = _ensureCountryRoot(byId, rootCountries, bucket) || nlId;
    if (!childrenByParent.has(countryId)) childrenByParent.set(countryId, []);
    childrenByParent.get(countryId).push({ id: pid });
  }

  const finalRoots = [];
  for (const c of rootCountries) finalRoots.push({ id: String(c.id) });
  for (const o of unbucketedOrphans) finalRoots.push(o);

  // Sort roots alphabetically by label.
  finalRoots.sort((a, b) => sortKey(byId.get(a.id)).localeCompare(sortKey(byId.get(b.id))));

  for (const r of finalRoots) sortChildren(r.id);

  const q = String(state.placesQuery || '').trim();
  const queryNorm = q ? _normKey(q) : '';
  const matchedIds = _computePlaceMatches(finalRoots, byId, childrenByParent, queryNorm);

  els.placesList.innerHTML = '';
  const frag = document.createDocumentFragment();

  // Basic "select on map" hook (map itself can come later).
  const onSelect = (node) => {
    try {
      window.dispatchEvent(new CustomEvent('relchart:place-selected', { detail: node }));
    } catch (_) {}
    // Future: center/zoom map to node.lat/node.lon.
  };

  for (const r of finalRoots) {
    const node = byId.get(r.id);
    if (!node) continue;
    // When searching, hide unrelated trees.
    if (queryNorm && !matchedIds.has(String(node.id))) continue;
    frag.appendChild(
      _renderPlacesTreeNode(node, byId, childrenByParent, {
        depth: 0,
        queryNorm,
        matchedIds,
        onSelect,
      })
    );
  }

  els.placesList.appendChild(frag);

  // Keep the popover anchored during list scroll.
  try {
    if (!state.placeEventsPanel.wiredScroll) {
      state.placeEventsPanel.wiredScroll = true;
      els.placesList.addEventListener('scroll', () => {
        _positionPlaceEventsPanel();
      }, { passive: true });
    }
  } catch (_) {}

  const total = places.length;
  const shown = els.placesList.querySelectorAll('.peopleItem.placesItem').length;
  els.placesStatus.textContent = queryNorm ? `Showing ${shown} of ${total}.` : `Showing ${total}.`;
}

async function ensurePlacesLoaded() {
  if (state.placesLoaded) return;
  if (!els.placesStatus || !els.placesList) return;

  els.placesStatus.textContent = 'Loading places…';
  try {
    const r = await fetch('/places?limit=50000&offset=0');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    state.places = results;
    state.placeById = new Map(results.map((p) => [String(p?.id || ''), p]).filter(([k]) => !!k));
    state.placesLoaded = true;
    _renderPlacesList(results);

    // Load event counts per place to drive the hamburger icon visibility.
    // This avoids per-row fetching and ensures icons appear without needing clicks.
    try {
      const r2 = await fetch('/places/events_counts');
      if (r2.ok) {
        const d2 = await r2.json();
        const rows = Array.isArray(d2?.results) ? d2.results : [];
        const m = new Map();
        for (const row of rows) {
          const pid = String(row?.place_id || '').trim();
          const n = Number(row?.events_total ?? 0);
          if (pid) m.set(pid, Number.isFinite(n) ? n : 0);
        }
        state.placeEventCountById = m;
        _applyPlacesMenuButtonVisibility();
      }
    } catch (_err) {
      // Non-fatal. Menu icons may still appear after opening a place panel.
    }
  } catch (e) {
    els.placesStatus.textContent = `Failed to load places: ${e?.message || e}`;
  }
}

function _selectParentFamilyForPersonInSidebar(personApiId) {
  const pid = String(personApiId || '').trim();
  if (!pid) return;
  if (_getSidebarActiveTab() !== 'families') return;

  const edges = Array.isArray(state.payload?.edges) ? state.payload.edges : [];
  let familyId = null;
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    if (String(e?.from || '') !== pid) continue;
    const fid = String(e?.to || '').trim();
    if (!fid) continue;
    familyId = fid;
    break;
  }
  // Fallback: if they are not a visible parent/spouse in any family, select their
  // parent family (i.e., the family where they appear as a child).
  if (!familyId) {
    for (const e of edges) {
      if (e?.type !== 'child') continue;
      if (String(e?.to || '') !== pid) continue;
      const fid = String(e?.from || '').trim();
      if (!fid) continue;
      familyId = fid;
      break;
    }
  }
  if (!familyId) return;

  const famNode = state.nodeById?.get?.(String(familyId)) || null;
  const key = String(famNode?.gramps_id || familyId || '').trim();
  if (!key) return;

  try { ensureFamiliesLoaded(); } catch (_) {}
  try { setSelectedFamilyKey(key, { source: 'person-parent', scrollFamilies: true }); } catch (_) {}
}

function _applyPlacesSelectionToDom({ scroll = true } = {}) {
  if (!els.placesList) return;
  const pid = String(state.placesSelected || state.map.pendingPlaceId || '').trim();

  for (const el of els.placesList.querySelectorAll('.peopleItem.selected')) {
    el.classList.remove('selected');
  }

  if (!pid) return;

  const sel = els.placesList.querySelector(`.peopleItem.placesItem[data-place-id="${_cssEscape(pid)}"]`);
  if (!sel) return;

  try { sel.classList.add('selected'); } catch (_err) {}

  // Ensure ancestors are open so the selection is visible.
  try {
    let d = sel.closest('details.placesGroup');
    while (d) {
      d.open = true;
      d = d.parentElement ? d.parentElement.closest('details.placesGroup') : null;
    }
  } catch (_err) {}

  if (!scroll) return;

  const scrollContainer = els.placesList;
  const centerSelected = () => {
    try {
      const cRect = scrollContainer.getBoundingClientRect();
      const eRect = sel.getBoundingClientRect();
      if (!cRect || !eRect) return;
      const desiredCenter = cRect.top + (cRect.height / 2);
      const currentCenter = eRect.top + (eRect.height / 2);
      const delta = currentCenter - desiredCenter;
      if (!Number.isFinite(delta)) return;
      scrollContainer.scrollTop += delta;
    } catch (_err) {
      try { sel.scrollIntoView({ block: 'center' }); } catch (_err2) {
        try { sel.scrollIntoView(); } catch (_err3) {}
      }
    }
  };

  try {
    requestAnimationFrame(() => {
      centerSelected();
      requestAnimationFrame(centerSelected);
    });
  } catch (_err) {
    centerSelected();
  }
}

// Keep the floating detail panel in sync with selection.
selection.subscribe((next) => {
  // Selection can be set from the graph (apiId) or from the People list (grampsId).
  // Backend endpoints accept either, so use whichever is available.
  // Prefer grampsId when present: it's what the user typed/selected.
  const ref = String(next?.grampsId || next?.apiId || next?.key || '').trim();
  if (!ref) return;

  // If the panel is closed, keep the peek tab visible and updated.
  if (!state.detailPanel.open) {
    try { _setDetailPeekVisible(true); } catch (_) {}
  }

  // Update detail data (and peek tab) without forcing the panel open.
  // Note: endpoints accept either Gramps ID or API id.
  try { loadPersonDetailsIntoPanel(ref, { openPanel: state.detailPanel.open }); } catch (_) {}

  // If the user is viewing Families, prefer selecting a relevant family.
  try {
    const tab = _getSidebarActiveTab();
    const apiId = String(next?.apiId || '').trim();
    if (tab === 'families' && apiId) {
      _selectParentFamilyForPersonInSidebar(apiId);
    }
  } catch (_) {}
});

function _normalizeGraphvizTitleToId(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  return t.replace(/^node\s+/i, '').trim();
}

function _findPersonNodeElement(svg, personId) {
  const pid = String(personId || '').trim();
  if (!svg || !pid) return null;
  const nodes = svg.querySelectorAll('g.node');
  for (const node of nodes) {
    try {
      if (node.querySelector('ellipse')) continue; // family hub
      const id = _normalizeGraphvizTitleToId(node.querySelector('title')?.textContent?.trim());
      if (id === pid) return node;
    } catch (_) {}
  }
  return null;
}

function _findExpandTabElement(svg, personId, expandKind) {
  const pid = String(personId || '').trim();
  const kind = String(expandKind || '').trim().toLowerCase();
  if (!svg || !pid) return null;

  const attr = (kind === 'children') ? 'data-hidden-children-for' : 'data-hidden-parents-for';
  const tabPolys = Array.from(svg.querySelectorAll(`polygon[${attr}="${pid}"]`));
  if (!tabPolys.length) return null;

  // Prefer the visible tab (it contains a <title>).
  const withTitle = tabPolys.find(el => !!el.querySelector('title'));
  return withTitle || tabPolys[0] || null;
}

function _clearGraphPersonSelection(svg) {
  if (!svg) return;
  try {
    for (const n of svg.querySelectorAll('g.node.personNode.selected')) {
      n.classList.remove('selected');
    }
  } catch (_) {}

  try {
    for (const el of svg.querySelectorAll('[data-selection-border="1"]')) {
      el.remove();
    }
  } catch (_) {}
}

function _applyGraphPersonSelection(svg, personId) {
  if (!svg) return;
  const pid = String(personId || '').trim();
  _clearGraphPersonSelection(svg);
  if (!pid) return;

  const node = _findPersonNodeElement(svg, pid);
  if (!node) return;

  try { node.classList.add('selected'); } catch (_) {}

  const graphLayer = (() => {
    // Graphviz typically wraps everything in a <g id="graph0">.
    const g0 = svg.querySelector('g#graph0');
    if (g0) return g0;
    // Fallback: choose the first top-level <g> if present.
    const g = svg.querySelector('g');
    return g || svg;
  })();

  const raiseFamilyHubsAboveSelection = () => {
    // Ensure hubs render above the selection outline by moving them to the end
    // of the Graphviz layer. Event listeners remain attached.
    try {
      const hubs = Array.from(graphLayer.querySelectorAll('g.node'))
        .filter((n) => !!n.querySelector('ellipse'));
      for (const hub of hubs) {
        try { graphLayer.appendChild(hub); } catch (_) {}
      }
    } catch (_) {}
  };

  // Add a black border overlay around the *whole* person card.
  // The card is composed of multiple overlapping paths, one of which may be
  // vertically translated. Instead of tracing a single path, we outline the
  // union of the card layers in SVG user-space.
  try {
    const isExpandTab = (el) => {
      if (!el) return false;
      try {
        if (el.matches?.('[data-hidden-parents-for],[data-hidden-children-for],[data-hidden-parents-hit],[data-hidden-children-hit]')) return true;
      } catch (_) {}
      return false;
    };

    const layerEls = (() => {
      const rimLayers = Array.from(node.querySelectorAll('[data-rim="1"]'))
        .filter((el) => !isExpandTab(el));
      if (rimLayers.length) return rimLayers;
      // Fallback if rim overlay wasn't built for some reason.
      const base = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
      return base ? [base] : [];
    })();

    if (!layerEls.length) return;

    // Union bounding rect in screen pixels.
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of layerEls) {
      try {
        const r = el.getBoundingClientRect?.();
        if (!r) continue;
        if (!Number.isFinite(r.left) || !Number.isFinite(r.top) || !Number.isFinite(r.right) || !Number.isFinite(r.bottom)) continue;
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      } catch (_) {}
    }
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return;
    if (right <= left || bottom <= top) return;

    // Convert screen rect -> the coordinate space of the layer we will append into.
    // g#graph0 is typically translated; using svg.getScreenCTM() would yield SVG-root
    // user-space, which becomes wrong once the border lives under g#graph0.
    const m = graphLayer.getScreenCTM?.() || svg.getScreenCTM?.();
    if (!m || typeof m.inverse !== 'function') return;
    const inv = m.inverse();

    const p0 = new DOMPoint(left, top).matrixTransform(inv);
    const p1 = new DOMPoint(right, bottom).matrixTransform(inv);

    // Outline thickness + padding.
    // Stroke is centered on the path. To avoid a visible inner gap, keep `pad` < strokeW/2
    // so the inner half of the stroke overlaps the card slightly.
    const strokeW = 4;
    const pad = 1.5;
    const x = Math.min(p0.x, p1.x) - pad;
    const y = Math.min(p0.y, p1.y) - pad;
    const w = Math.abs(p1.x - p0.x) + (pad * 2);
    const h = Math.abs(p1.y - p0.y) + (pad * 2);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

    // Corner radius: match the card's rounded corners.
    const rr = Math.max(0, Math.min(20, Math.min(w, h) / 3.2));
    const roundedRectPath = (x0, y0, w0, h0, r) => {
      const xA = x0;
      const yA = y0;
      const xB = x0 + w0;
      const yB = y0 + h0;
      const rad = Math.max(0, Math.min(r, Math.min(w0, h0) / 2));
      return [
        `M ${xA + rad} ${yA}`,
        `H ${xB - rad}`,
        `A ${rad} ${rad} 0 0 1 ${xB} ${yA + rad}`,
        `V ${yB - rad}`,
        `A ${rad} ${rad} 0 0 1 ${xB - rad} ${yB}`,
        `H ${xA + rad}`,
        `A ${rad} ${rad} 0 0 1 ${xA} ${yB - rad}`,
        `V ${yA + rad}`,
        `A ${rad} ${rad} 0 0 1 ${xA + rad} ${yA}`,
        'Z',
      ].join(' ');
    };

    const ns = 'http://www.w3.org/2000/svg';
    const border = document.createElementNS(ns, 'path');
    border.setAttribute('d', roundedRectPath(x, y, w, h, rr));
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', '#000');
    border.setAttribute('stroke-width', String(strokeW));
    border.setAttribute('opacity', '1');
    border.setAttribute('data-selection-border', '1');
    border.style.pointerEvents = 'none';

    // Put the outline in the Graphviz layer so we can control z-order relative
    // to hubs by reordering nodes within that same layer.
    graphLayer.appendChild(border);
    raiseFamilyHubsAboveSelection();
  } catch (_) {}
}

function _resolveSelectedPersonIdFromPayload(payload, sel) {
  const s = sel?.get?.() || {};
  const wantApi = String(s.apiId || '').trim();
  const wantGramps = String(s.grampsId || '').trim();
  const wantKey = String(s.key || '').trim();

  if (!payload?.nodes) return null;

  // Prefer explicit api id.
  if (wantApi) {
    const hit = payload.nodes.find(n => String(n?.id || '').trim() === wantApi);
    if (hit) return String(hit.id);
  }

  // Then gramps id / key.
  const want = wantGramps || wantKey;
  if (want) {
    const hit = payload.nodes.find(n => n?.type === 'person' && String(n?.gramps_id || '').trim() === want);
    if (hit) return String(hit.id);
  }

  return null;
}

function _getPersonNodeCenterSvg(svg, personId) {
  const node = _findPersonNodeElement(svg, personId);
  if (!node) return null;
  const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
  if (!shape || typeof shape.getBBox !== 'function') return null;
  const bb = shape.getBBox();
  if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) return null;
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
}

function _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind } = {}) {
  const svg = els.chart?.querySelector('svg');
  if (!svg) return null;

  const vb = (state.panZoom?.getViewBox?.() || null);
  const viewBox = vb && Number.isFinite(vb.w) && Number.isFinite(vb.h)
    ? vb
    : (() => {
        const b = svg.viewBox?.baseVal;
        if (!b) return null;
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      })();
  if (!viewBox || !Number.isFinite(viewBox.w) || !Number.isFinite(viewBox.h) || viewBox.w <= 0 || viewBox.h <= 0) return null;

  const containerRect = els.chart.getBoundingClientRect();
  if (!containerRect || !Number.isFinite(containerRect.width) || !Number.isFinite(containerRect.height) || containerRect.width <= 0 || containerRect.height <= 0) return null;

  // Preferred: anchor to the actual click location (expand arrow).
  let desiredClient = null;
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    const rx = cx - containerRect.left;
    const ry = cy - containerRect.top;
    if (Number.isFinite(rx) && Number.isFinite(ry)) desiredClient = { x: rx, y: ry };
  }

  // If this came from an expand click, also capture the offset within the tab
  // so we can keep the exact clicked point stable (not just the tab center).
  let anchorOffset = { x: 0, y: 0 };
  const kind = String(expandKind || '').trim().toLowerCase();
  if (desiredClient && (kind === 'parents' || kind === 'children')) {
    const tabEl = _findExpandTabElement(svg, personId, kind);
    if (tabEl && typeof tabEl.getBoundingClientRect === 'function') {
      try {
        const tr = tabEl.getBoundingClientRect();
        const tc = {
          x: (tr.left + tr.width / 2) - containerRect.left,
          y: (tr.top + tr.height / 2) - containerRect.top,
        };
        if (Number.isFinite(tc.x) && Number.isFinite(tc.y)) {
          anchorOffset = {
            x: desiredClient.x - tc.x,
            y: desiredClient.y - tc.y,
          };
        }
      } catch (_) {}
    }
  }

  // Fallback: anchor to the card center.
  if (!desiredClient) {
    const nodeEl = _findPersonNodeElement(svg, personId);
    if (!nodeEl || typeof nodeEl.getBoundingClientRect !== 'function') return null;
    const r = nodeEl.getBoundingClientRect();
    desiredClient = {
      x: (r.left + r.width / 2) - containerRect.left,
      y: (r.top + r.height / 2) - containerRect.top,
    };
    if (!Number.isFinite(desiredClient.x) || !Number.isFinite(desiredClient.y)) return null;
  }

  return {
    personId: String(personId),
    expandKind: kind || null,
    viewBox,
    desiredClient,
    anchorOffset,
  };
}

function _restoreViewAnchorForPerson(anchor) {
  if (!anchor) return;
  const svg = els.chart?.querySelector('svg');
  if (!svg) return;

  const viewBox = anchor.viewBox;
  const desiredClient = anchor.desiredClient;
  const anchorOffset = anchor.anchorOffset || { x: 0, y: 0 };
  const containerRect = els.chart.getBoundingClientRect();
  if (!containerRect || !Number.isFinite(containerRect.width) || !Number.isFinite(containerRect.height) || containerRect.width <= 0 || containerRect.height <= 0) return;

  const clientDeltaToSvgDelta = (dxPx, dyPx) => {
    const dx = Number(dxPx);
    const dy = Number(dyPx);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    try {
      const m = svg.getScreenCTM?.();
      if (!m || typeof m.inverse !== 'function') return null;
      const inv = m.inverse();
      // Transform as a vector by subtracting two transformed points.
      const p0 = new DOMPoint(0, 0).matrixTransform(inv);
      const p1 = new DOMPoint(dx, dy).matrixTransform(inv);
      const dxSvg = p1.x - p0.x;
      const dySvg = p1.y - p0.y;
      if (!Number.isFinite(dxSvg) || !Number.isFinite(dySvg)) return null;
      return { dxSvg, dySvg };
    } catch (_) {
      return null;
    }
  };

  const measureCurrentCenter = () => {
    const kind = String(anchor.expandKind || '').trim().toLowerCase();
    const tabEl = (kind === 'parents' || kind === 'children')
      ? _findExpandTabElement(svg, anchor.personId, kind)
      : null;
    const el = tabEl || _findPersonNodeElement(svg, anchor.personId);
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2) - containerRect.left,
      y: (r.top + r.height / 2) - containerRect.top,
    };
  };

  const desiredCenter = {
    x: desiredClient.x - Number(anchorOffset.x || 0),
    y: desiredClient.y - Number(anchorOffset.y || 0),
  };

  const computeAndApplyOnce = () => {
    // Start from the pre-expand viewBox (preserve zoom level exactly).
    state.panZoom?.setViewBox?.(viewBox);

    const current = measureCurrentCenter();
    if (!current) return;
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) return;

    // How far did the card drift on-screen? Convert that pixel drift back to
    // SVG units and pan by the same amount so the card returns to its old
    // screen position.
    const dxPx = current.x - desiredCenter.x;
    const dyPx = current.y - desiredCenter.y;
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;

    const vbNow = state.panZoom?.getViewBox?.() || viewBox;
    if (!vbNow || !Number.isFinite(vbNow.w) || !Number.isFinite(vbNow.h) || vbNow.w <= 0 || vbNow.h <= 0) return;

    const del = clientDeltaToSvgDelta(dxPx, dyPx);
    // Fallback if CTM isn't available.
    const dxSvg = del ? del.dxSvg : (dxPx * (vbNow.w / containerRect.width));
    const dySvg = del ? del.dySvg : (dyPx * (vbNow.h / containerRect.height));

    const corrected = {
      x: vbNow.x + dxSvg,
      y: vbNow.y + dySvg,
      w: vbNow.w,
      h: vbNow.h,
    };

    state.panZoom?.setViewBox?.(corrected);
  };

  // Two frames: first after SVG insertion, second after fonts/layout settle.
  try {
    requestAnimationFrame(() => {
      computeAndApplyOnce();
      requestAnimationFrame(() => {
        // One more correction pass if needed (crowded relayout can shift late).
        computeAndApplyOnce();
        requestAnimationFrame(computeAndApplyOnce);
      });
    });
  } catch (_) {
    computeAndApplyOnce();
  }
}

function setStatus(msg, isError = false) {
  const m = String(msg ?? '');
  els.status.textContent = m;
  els.status.title = m;
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';

  // Remember the last non-Map status so leaving the Map tab doesn't keep a
  // stale "Map: ..." message in the topbar.
  try {
    if (!/^map\s*:/i.test(m)) {
      state.status.lastNonMapMsg = m;
      state.status.lastNonMapIsError = !!isError;
    }
  } catch (_) {}
}

async function copyToClipboard(text) {
  const s = String(text ?? '');
  if (!s) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_) {}

  // Fallback for environments where Clipboard API isn't available.
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

function rebuildNodeIndex(payload) {
  const m = new Map();
  for (const n of (payload?.nodes || [])) {
    if (!n?.id) continue;
    m.set(String(n.id), n);
  }
  state.nodeById = m;
}

function formatIdStatus({ kind, apiId, grampsId }) {
  const a = String(apiId || '').trim();
  const g = String(grampsId || '').trim();
  const k = String(kind || 'node');
  if (a && g) return `${k}: api=${a} · gramps=${g}`;
  if (a) return `${k}: api=${a}`;
  if (g) return `${k}: gramps=${g}`;
  return `${k}: (no id)`;
}

async function rerender() {
  if (!state.payload) return;
  rebuildNodeIndex(state.payload);
  const { panZoom } = await renderRelationshipChart({
    container: els.graphView || els.chart,
    payload: state.payload,
    onSelectPerson: (pid) => {
      state.selectedPersonId = pid;
      try {
        const svg = (els.graphView || els.chart)?.querySelector('svg');
        _applyGraphPersonSelection(svg, pid);
      } catch (_) {}

      // Update detail data (and peek tab) without forcing the panel open.
      try { loadPersonDetailsIntoPanel(pid, { openPanel: state.detailPanel.open }); } catch (_) {}

      const node = state.nodeById.get(String(pid)) || null;
      // Graph click behaves like a global selection, but should not force sidebar tab switches.
      const activeTab = _getSidebarActiveTab();
      selection.selectPerson(
        { apiId: pid, grampsId: node?.gramps_id },
        { source: 'graph', scrollPeople: activeTab === 'people', updateInput: true },
      );
      // If the user is currently viewing Families, prefer selecting a family where this person is a parent.
      try { _selectParentFamilyForPersonInSidebar(pid); } catch (_) {}
      const msg = formatIdStatus({
        kind: 'Person',
        apiId: pid,
        grampsId: node?.gramps_id,
      });
      setStatus(msg);
      const copyText = node?.gramps_id
        ? `api_id=${String(pid)}\ngramps_id=${String(node.gramps_id)}`
        : `api_id=${String(pid)}`;
      copyToClipboard(copyText).then((ok) => {
        if (ok) setStatus(msg + ' (copied)');
      });
    },
    onSelectFamily: (fid) => {
      const node = state.nodeById.get(String(fid)) || null;

      // Behave like a global selection: switch to Families and scroll-highlight.
      try { _setSidebarActiveTab('families'); } catch (_) {}
      try { ensureFamiliesLoaded(); } catch (_) {}
      try { setSelectedFamilyKey(String(node?.gramps_id || fid || '').trim(), { source: 'graph', scrollFamilies: true }); } catch (_) {}

      const msg = formatIdStatus({
        kind: 'Family',
        apiId: fid,
        grampsId: node?.gramps_id,
      });
      setStatus(msg);
      const copyText = node?.gramps_id
        ? `api_id=${String(fid)}\ngramps_id=${String(node.gramps_id)}`
        : `api_id=${String(fid)}`;
      copyToClipboard(copyText).then((ok) => {
        if (ok) setStatus(msg + ' (copied)');
      });
    },
    onExpandParents: async ({ personId, familyId, expandKind, clientX, clientY }) => {
      if (!familyId) return;
      const anchor = _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind });
      setStatus(`Expanding parents: ${familyId} …`);
      const delta = await api.familyParents({ familyId, childId: personId });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerender();
      _restoreViewAnchorForPerson(anchor);
    },
    onExpandChildren: async ({ personId, familyId, expandKind, clientX, clientY }) => {
      if (!familyId) return;
      const anchor = _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind });
      setStatus(`Expanding children: ${familyId} …`);
      const delta = await api.familyChildren({ familyId, includeSpouses: true });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerender();
      _restoreViewAnchorForPerson(anchor);
    },
    onFit: (fn) => {
      els.fitBtn.onclick = fn;
    },
  });

  state.panZoom = panZoom;

  // Re-apply the latched person selection after every full rerender.
  try {
    const svg = (els.graphView || els.chart)?.querySelector('svg');
    _applyGraphPersonSelection(svg, state.selectedPersonId);
  } catch (_) {}
}

async function loadNeighborhood() {
  const personId = String(els.personId.value || '').trim();
  const depth = Number(els.depth.value || '2');
  const maxNodes = Number(els.maxNodes.value || '1000');

  if (!personId) {
    setStatus('Missing Person ID', true);
    return;
  }

  setStatus('Loading…');
  try {
    state.payload = await api.neighborhood({ personId, depth, maxNodes });

    // When the user typed a Person ID and clicked Load, treat that as the new
    // global selection so the People list + detail panel stay in sync.
    const requested = String(personId || '').trim();
    const nodes = Array.isArray(state.payload?.nodes) ? state.payload.nodes : [];
    const looksLikeGrampsId = /^I\d+$/i.test(requested);
    const directHit = nodes.find(n => {
      if (n?.type !== 'person') return false;
      const apiId = String(n?.id || '').trim();
      const gid = String(n?.gramps_id || '').trim();
      return (gid && gid === requested) || (apiId && apiId === requested);
    }) || null;

    const resolvedApiId = directHit?.id ? String(directHit.id) : null;
    let resolvedGrampsId = String(directHit?.gramps_id || '').trim() || null;

    // For a manual Load, prefer the requested person (so we don't keep a stale
    // prior selection like I0001 when the user loads I0022).
    state.selectedPersonId = resolvedApiId || _resolveSelectedPersonIdFromPayload(state.payload, selection);
    if (state.selectedPersonId && !resolvedGrampsId) {
      const byApi = nodes.find(n => n?.type === 'person' && String(n?.id || '').trim() === String(state.selectedPersonId)) || null;
      resolvedGrampsId = String(byApi?.gramps_id || '').trim() || null;
    }

    // Finally, make the selection store reflect what we just loaded.
    // Prefer gramps id for keying the People list; always include api id when known.
    const activeTab = _getSidebarActiveTab();
    selection.selectPerson(
      {
        apiId: state.selectedPersonId || null,
        grampsId: resolvedGrampsId || (looksLikeGrampsId ? requested : null),
      },
      { source: 'load', scrollPeople: activeTab === 'people', updateInput: true },
    );

    setStatus(`Loaded ${state.payload.nodes?.length || 0} nodes, ${state.payload.edges?.length || 0} edges.`);
    await rerender();
  } catch (e) {
    setStatus(`Failed: ${e?.message || e}`, true);
  }
}

els.loadBtn.addEventListener('click', loadNeighborhood);

els.resetBtn.addEventListener('click', () => {
  state.payload = null;
  state.selectedPersonId = null;
  if (els.graphView) els.graphView.innerHTML = '';
  else if (els.chart) els.chart.innerHTML = '';
  setStatus('Ready.');
});

// When a place is selected from the Map tab list, center the map (if available).
try {
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
      Promise.resolve(ensurePlacesLoaded()).then(() => {
        const place = _resolvePlaceForMap(detail);
        _centerMapOnPlace(place);
        try { _applyPlacesSelectionToDom({ scroll: true }); } catch (_) {}
      });
    });
  });
} catch (_) {}

els.fitBtn.addEventListener('click', () => {
  state.panZoom?.reset?.();
});

// Initial
setStatus('Ready.');
_initPeopleExpanded();
try { _initMapTopbarControls(); } catch (_) {}
try { _setTopbarControlsMode(_getSidebarActiveTab() === 'map' ? 'map' : 'graph'); } catch (_) {}

_loadDetailPanelPos();
_loadDetailPanelSize();
_renderPersonDetailPanelSkeleton();
try { _ensureDetailPeekTab(); } catch (_) {}
try { _positionDetailPeekTab(); } catch (_) {}
try { _applyDetailPanelSize(); } catch (_) {}
try { _applyDetailPanelPos(); } catch (_) {}

try {
  window.addEventListener('resize', () => {
    _applyDetailPanelSize();
    _applyDetailPanelPos();
    _positionDetailPeekTab();
  });
} catch (_) {}

// Auto-load the graph on first page load (using the current form values).
try { loadNeighborhood(); } catch (_) {}

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
}


async function ensureFamiliesLoaded() {
  if (state.familiesLoaded) return;
  if (!els.familiesStatus || !els.familiesList) return;

  els.familiesStatus.textContent = 'Loading families…';
  try {
    _wireFamiliesClicks();
    const r = await fetch('/families?limit=50000&offset=0');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    // Hide private families from the global index.
    const visible = results.filter((f) => !f?.is_private);
    // Prefer stable sorting by Gramps ID.
    visible.sort((a, b) => String(a?.gramps_id || '').localeCompare(String(b?.gramps_id || '')));
    state.families = visible;
    state.familiesLoaded = true;
    _renderFamiliesList(visible, els.familiesSearch?.value || '');
    // If a family was selected from the graph before the Families tab loaded.
    _applyFamiliesSelectionToDom({ scroll: true });
  } catch (e) {
    els.familiesStatus.textContent = `Failed to load families: ${e?.message || e}`;
  }
}

async function ensureEventsLoaded() {
  if (state.eventsLoaded) return;
  if (!els.eventsStatus || !els.eventsList) return;

  const seq = ++state.eventsReqSeq;
  state.eventsLoading = true;
  state.eventsOffset = 0;
  state.eventsHasMore = false;
  state.eventsTotal = null;
  state.events = [];

  els.eventsStatus.textContent = 'Loading events…';
  try {
    const params = new URLSearchParams();
    params.set('limit', String(state.eventsPageSize || 500));
    params.set('offset', '0');
    params.set('sort', String(state.eventsSort || 'type_asc'));
    const q = String(state.eventsQuery || '').trim();
    if (q) params.set('q', q);

    const r = await fetch(`/events?${params.toString()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (seq !== state.eventsReqSeq) return;

    const results = Array.isArray(data?.results) ? data.results : [];
    state.events = results;
    state.eventsLoaded = true;
    state.eventsHasMore = Boolean(data?.has_more);
    state.eventsOffset = Number.isFinite(data?.next_offset) ? data.next_offset : results.length;
    state.eventsTotal = Number.isFinite(data?.total) ? data.total : null;

    _renderEventsList(state.events, '');
  } catch (e) {
    if (seq !== state.eventsReqSeq) return;
    els.eventsStatus.textContent = `Failed to load events: ${e?.message || e}`;
  } finally {
    if (seq === state.eventsReqSeq) state.eventsLoading = false;
  }
}

async function _fetchMoreEventsPage() {
  if (!state.eventsServerMode) return;
  if (!state.eventsLoaded) return;
  if (state.eventsLoading) return;
  if (!state.eventsHasMore) return;
  if (!els.eventsList) return;

  const seq = ++state.eventsReqSeq;
  state.eventsLoading = true;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(state.eventsPageSize || 500));
    params.set('offset', String(state.eventsOffset || 0));
    params.set('sort', String(state.eventsSort || 'type_asc'));
    const q = String(state.eventsQuery || '').trim();
    if (q) params.set('q', q);

    const r = await fetch(`/events?${params.toString()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (seq !== state.eventsReqSeq) return;

    const results = Array.isArray(data?.results) ? data.results : [];
    const seen = new Set((state.events || []).map((ev) => String(ev?.id || '')));
    for (const ev of results) {
      const id = String(ev?.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      state.events.push(ev);
    }

    state.eventsHasMore = Boolean(data?.has_more);
    state.eventsOffset = Number.isFinite(data?.next_offset) ? data.next_offset : (state.eventsOffset + results.length);
    _renderEventsList(state.events, '');
  } catch (_) {
    // Ignore; keep existing results.
  } finally {
    if (seq === state.eventsReqSeq) state.eventsLoading = false;
  }
}

// Load people list lazily when the People tab is opened.
const peopleTabBtn = document.querySelector('.tabbtn[data-tab="people"]');
if (peopleTabBtn) {
  peopleTabBtn.addEventListener('click', () => {
    try { _setSidebarActiveTab('people'); } catch (_) {}
  });
}

// Load families list lazily when the Families tab is opened.
const familiesTabBtn = document.querySelector('.tabbtn[data-tab="families"]');
if (familiesTabBtn) {
  familiesTabBtn.addEventListener('click', () => {
    try { _setSidebarActiveTab('families'); } catch (_) {}
  });
}

// Load events list lazily when the Events tab is opened.
const eventsTabBtn = document.querySelector('.tabbtn[data-tab="events"]');
if (eventsTabBtn) {
  eventsTabBtn.addEventListener('click', () => {
    try { _setSidebarActiveTab('events'); } catch (_) {}
  });
}

initPeopleFeature({ loadNeighborhood });

if (els.familiesSearch) {
  const updateClearVisibility = () => {
    if (!els.familiesSearchClear) return;
    const has = String(els.familiesSearch.value || '').length > 0;
    els.familiesSearchClear.style.display = has ? 'inline-flex' : 'none';
  };

  const doRerender = () => {
    if (!state.familiesLoaded || !state.families) return;
    _renderFamiliesList(state.families, els.familiesSearch.value);
  };

  els.familiesSearch.addEventListener('input', () => {
    updateClearVisibility();
    doRerender();
  });

  els.familiesSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.familiesSearch.value) return;
      els.familiesSearch.value = '';
      updateClearVisibility();
      doRerender();
      try { els.familiesSearch.focus(); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    }
  });

  if (els.familiesSearchClear) {
    els.familiesSearchClear.addEventListener('click', () => {
      if (!els.familiesSearch) return;
      if (!els.familiesSearch.value) return;
      els.familiesSearch.value = '';
      updateClearVisibility();
      doRerender();
      try { els.familiesSearch.focus(); } catch (_) {}
    });
  }

  updateClearVisibility();
}

if (els.eventsSearch) {
  const updateClearVisibility = () => {
    if (!els.eventsSearchClear) return;
    const has = String(els.eventsSearch.value || '').length > 0;
    els.eventsSearchClear.style.display = has ? 'inline-flex' : 'none';
  };

  let _eventsSearchTimer = null;
  const scheduleReload = () => {
    if (_eventsSearchTimer) clearTimeout(_eventsSearchTimer);
    _eventsSearchTimer = setTimeout(() => {
      state.eventsQuery = String(els.eventsSearch.value || '').trim();
      if (state.eventsServerMode) {
        state.eventsLoaded = false;
        ensureEventsLoaded();
      } else {
        if (!state.eventsLoaded || !state.events) return;
        _renderEventsList(state.events, els.eventsSearch.value);
      }
    }, 250);
  };

  els.eventsSearch.addEventListener('input', () => {
    updateClearVisibility();
    scheduleReload();
  });

  els.eventsSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.eventsSearch.value) return;
      els.eventsSearch.value = '';
      updateClearVisibility();
      scheduleReload();
      try { els.eventsSearch.focus(); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    }
  });

  if (els.eventsSearchClear) {
    els.eventsSearchClear.addEventListener('click', () => {
      if (!els.eventsSearch) return;
      if (!els.eventsSearch.value) return;
      els.eventsSearch.value = '';
      updateClearVisibility();
      scheduleReload();
      try { els.eventsSearch.focus(); } catch (_) {}
    });
  }

  updateClearVisibility();
}

if (els.eventsSort) {
  // Ensure DOM reflects default state.
  try { els.eventsSort.value = String(state.eventsSort || 'type_asc'); } catch (_) {}
  els.eventsSort.addEventListener('change', () => {
    state.eventsSort = String(els.eventsSort.value || 'type_asc');
    if (state.eventsServerMode) {
      state.eventsLoaded = false;
      ensureEventsLoaded();
    } else {
      if (!state.eventsLoaded || !state.events) return;
      _renderEventsList(state.events, els.eventsSearch?.value || '');
    }
  });
}

if (els.placesSearch) {
  const updateClearVisibility = () => {
    if (!els.placesSearchClear) return;
    const has = String(els.placesSearch.value || '').length > 0;
    els.placesSearchClear.style.display = has ? 'inline-flex' : 'none';
  };

  let _placesSearchTimer = null;
  const scheduleRerender = () => {
    if (_placesSearchTimer) clearTimeout(_placesSearchTimer);
    _placesSearchTimer = setTimeout(() => {
      state.placesQuery = String(els.placesSearch.value || '').trim();
      if (!state.placesLoaded || !state.places) return;
      _renderPlacesList(state.places);
    }, 120);
  };

  els.placesSearch.addEventListener('input', () => {
    updateClearVisibility();
    scheduleRerender();
  });

  els.placesSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.placesSearch.value) return;
      els.placesSearch.value = '';
      updateClearVisibility();
      scheduleRerender();
      try { els.placesSearch.focus(); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    }
  });

  if (els.placesSearchClear) {
    els.placesSearchClear.addEventListener('click', () => {
      if (!els.placesSearch) return;
      if (!els.placesSearch.value) return;
      els.placesSearch.value = '';
      updateClearVisibility();
      scheduleRerender();
      try { els.placesSearch.focus(); } catch (_) {}
    });
  }

  updateClearVisibility();
}

// Infinite scroll for server-paged events.
if (els.eventsList) {
  let _eventsScrollTimer = null;
  els.eventsList.addEventListener('scroll', () => {
    if (!state.eventsServerMode) return;
    if (_eventsScrollTimer) return;
    _eventsScrollTimer = setTimeout(() => {
      _eventsScrollTimer = null;
      const el = els.eventsList;
      if (!el) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 240;
      if (!nearBottom) return;
      _fetchMoreEventsPage();
    }, 120);
  });
}
