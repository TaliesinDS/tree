import { els, state } from '../state.js';
import { _cssEscape } from '../util/dom.js';
import { copyToClipboard } from '../util/clipboard.js';

let _setStatus = null;
let _loadNeighborhood = null;
let _selection = null;
let _getSidebarActiveTab = null;
let _formatEventTitle = null;
let _formatEventSubLineNoPlace = null;

export function initPlacesFeature({
  setStatus,
  loadNeighborhood,
  selection,
  getSidebarActiveTab,
  formatEventTitle,
  formatEventSubLineNoPlace,
} = {}) {
  _setStatus = typeof setStatus === 'function' ? setStatus : null;
  _loadNeighborhood = typeof loadNeighborhood === 'function' ? loadNeighborhood : null;
  _selection = selection || null;
  _getSidebarActiveTab = typeof getSidebarActiveTab === 'function' ? getSidebarActiveTab : null;
  _formatEventTitle = typeof formatEventTitle === 'function' ? formatEventTitle : null;
  _formatEventSubLineNoPlace = typeof formatEventSubLineNoPlace === 'function' ? formatEventSubLineNoPlace : null;

  // Search/filter wiring
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

  // Keep panel positioned on resize.
  try {
    window.addEventListener('resize', () => {
      _positionPlaceEventsPanel();
    });
  } catch (_) {}
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

function _setStatusSafe(msg, isError) {
  try {
    if (_setStatus) _setStatus(msg, isError);
  } catch (_) {}
}

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
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
    closePlaceEventsPanel();
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

    const activeTab = _getSidebarActiveTab ? _getSidebarActiveTab() : null;
    try {
      _selection?.selectPerson?.(
        { apiId, grampsId },
        { source: 'place-events', scrollPeople: activeTab === 'people', updateInput: true },
      );
    } catch (_) {}

    const who = String(btn?.textContent || '').trim() || grampsId || apiId;
    _setStatusSafe(`Selected: ${who}`);
  });

  els.placeEventsPanel = panel;
  document.body.appendChild(panel);
}

export function closePlaceEventsPanel() {
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
    closePlaceEventsPanel();
    return;
  }
  const r = a.getBoundingClientRect();

  // If the anchor is fully out of view, close the panel.
  // This avoids the panel sticking to the top/bottom edge when scrolling.
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
    closePlaceEventsPanel();
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
    bodyEl.innerHTML = '<div class="placeEventsEmpty">No public events found for this place.</div>';
    return;
  }

  const fmtTitle = _formatEventTitle || ((ev) => String(ev?.type || 'Event'));
  const fmtSub = _formatEventSubLineNoPlace || ((ev) => String(ev?.date_text || ev?.date || '').trim());

  const items = evs.map((ev) => {
    const apiId = String(ev?.id || '').trim();
    const gid = String(ev?.gramps_id || '').trim();
    const idLabel = gid || apiId;
    const eventTitle = fmtTitle(ev);
    const primary = ev?.primary_person || null;
    const primaryName = String(primary?.display_name || '').trim();
    const primaryApiId = String(primary?.id || '').trim();
    const primaryGrampsId = String(primary?.gramps_id || '').trim();
    const sub = fmtSub(ev);
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
    closePlaceEventsPanel();
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

export function selectPlaceGlobal(placeLike, { emitMapEvent = true } = {}) {
  const place = (typeof placeLike === 'string') ? { id: placeLike } : (placeLike || null);
  const pid = String(place?.id || '').trim();
  if (!pid) return;

  // If a different place becomes selected, close any open place-events panel.
  try {
    const openPid = String(state.placeEventsPanel?.placeId || '').trim();
    if (openPid && openPid !== pid) closePlaceEventsPanel();
  } catch (_) {}

  state.placesSelected = pid;
  state.map.pendingPlaceId = pid;

  // Highlight in the Places list (if already rendered).
  try {
    _applyPlacesSelectionToDom({ scroll: true });
  } catch (_) {}

  try {
    const label = _placeLabel(place);
    const meta = _placeMeta(place);
    _setStatusSafe(`Place: ${meta || pid} · ${label}`);
  } catch (_) {}

  if (emitMapEvent) {
    // Note: this should never force the map to become visible.
    try { window.dispatchEvent(new CustomEvent('relchart:place-selected', { detail: place })); } catch (_) {}
  }

  // Prime menu availability for this place.
  try { Promise.resolve(_ensurePlaceEventsLoaded(pid)).catch(() => {}); } catch (_) {}
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

function _isCountryPlace(p) {
  const t = _normPlaceType(p?.type).toLowerCase();
  if (!t) return false;
  return t === 'country' || t === 'land' || t === 'nation';
}

function _isLikelyCountryName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
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

function _renderPlacesTreeNode(node, byId, childrenByParent, opts) {
  const { depth, queryNorm, matchedIds, onSelect } = opts;
  const allChildren = childrenByParent.get(node.id) || [];
  // When searching, only render branches that contain matches.
  const children = queryNorm
    ? allChildren.filter((c) => matchedIds.has(String(c?.id)))
    : allChildren;
  const hasChildren = children.length > 0;

  const INDENT_PX = 18;

  const _placeBreadcrumb = () => {
    const enclosure = Array.isArray(node?.enclosure) ? node.enclosure : [];
    const anc = enclosure
      .map((e) => String(e?.name || '').trim())
      .filter((s) => s)
      .reverse();
    const self = _placeLabel(node);
    return [...anc, self].filter((s) => s).join(' > ');
  };

  const selectThisPlace = (rowEl, { emitMapEvent = true } = {}) => {
    const pid = String(node.id || '').trim();
    if (!pid) return;

    // If a different place becomes selected, close any open place-events panel.
    try {
      const openPid = String(state.placeEventsPanel?.placeId || '').trim();
      if (openPid && openPid !== pid) closePlaceEventsPanel();
    } catch (_) {}

    state.placesSelected = pid;
    state.map.pendingPlaceId = pid;
    try {
      if (els.placesList) {
        for (const el of els.placesList.querySelectorAll('.peopleItem.selected')) el.classList.remove('selected');
      }
      rowEl.classList.add('selected');
    } catch (_) {}
    _setStatusSafe(`Place: ${_placeMeta(node) || pid} · ${_placeLabel(node)}`);
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

      try { selectThisPlace(rowEl, { emitMapEvent: true }); } catch (_) {}

      const gid = String(node?.gramps_id || '').trim();
      const internal = String(node?.id || '').trim();
      const idPart = gid ? `${gid} (${internal})` : internal;
      const crumb = _placeBreadcrumb();
      const text = `${idPart}\t${crumb}`;
      const ok = await copyToClipboard(text);
      _setStatusSafe(ok ? `Copied: ${idPart} · ${crumb}` : 'Copy failed.');
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

function _renderPlacesList(allPlaces) {
  if (!els.placesList || !els.placesStatus) return;

  // Re-rendering the list invalidates anchors; close any open popover.
  try { closePlaceEventsPanel(); } catch (_) {}

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
    return `${norm}\u0000${label}\u0000${gid}\u0000${pid}`;
  };
  const sortChildren = (parentId) => {
    const kids = childrenByParent.get(parentId) || [];
    kids.sort((a, b) => sortKey(byId.get(a.id)).localeCompare(sortKey(byId.get(b.id))));
    for (const k of kids) sortChildren(k.id);
  };

  // Country normalization: keep countries as top-level roots.
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

  // Basic "select on map" hook.
  const onSelect = (node) => {
    try {
      window.dispatchEvent(new CustomEvent('relchart:place-selected', { detail: node }));
    } catch (_) {}
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

export async function ensurePlacesLoaded() {
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
      // Non-fatal.
    }
  } catch (e) {
    els.placesStatus.textContent = `Failed to load places: ${e?.message || e}`;
  }
}

export function _applyPlacesSelectionToDom({ scroll = true } = {}) {
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
