import * as api from './api.js';
import { renderRelationshipChart } from './chart/render.js';
import { mergeGraphPayload } from './chart/payload.js';
import { formatGrampsDateEnglish, formatGrampsDateEnglishCard } from './util/date.js';

import { els, state } from './state.js';
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
import {
  initFamiliesFeature,
  ensureFamiliesLoaded,
  setSelectedFamilyKey,
  _applyFamiliesSelectionToDom,
  _renderFamiliesList,
} from './features/families.js';
import {
  initMapFeature,
  ensureMapInitialized,
  resolvePlaceForMap,
  centerMapOnPlace,
  onEnterMapTab,
  onLeaveMapTab,
} from './features/map.js';
import {
  initPlacesFeature,
  ensurePlacesLoaded,
  selectPlaceGlobal,
  closePlaceEventsPanel,
  _applyPlacesSelectionToDom,
} from './features/places.js';

function _setTopbarControlsMode(kind) {
  const k = String(kind || '').trim().toLowerCase();
  const showMap = (k === 'map');
  if (els.graphControls) els.graphControls.hidden = showMap;
  if (els.mapControls) els.mapControls.hidden = !showMap;
}

function _setMainView(viewName) {
  const v = String(viewName || '').trim().toLowerCase();
  if (!els.chart) return;
  els.chart.dataset.mainView = (v === 'map') ? 'map' : 'graph';
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

    try { selectPlaceGlobal(place, { emitMapEvent: true }); } catch (_) {}
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
    if (name !== 'map') closePlaceEventsPanel();
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
      try { onLeaveMapTab(); } catch (_) {}

      try {
        const cur = String(els.status?.textContent || '').trim();
        if (/^map\s*:/i.test(cur)) {
          setStatus(state.status.lastNonMapMsg, state.status.lastNonMapIsError);
        }
      } catch (_) {}
    }

    if (name === 'map') {
      try { onEnterMapTab(); } catch (_) {}
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
            const p = resolvePlaceForMap(pid);
            centerMapOnPlace(p);
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
        const place = resolvePlaceForMap(detail);
        centerMapOnPlace(place);
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
initMapFeature({
  setStatus,
  ensurePlacesLoaded,
  selectPlaceGlobal,
  resolveRelationsRootPersonId: _resolveRelationsRootPersonId,
});
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

initFamiliesFeature({ setStatus, loadNeighborhood });

initPlacesFeature({
  setStatus,
  loadNeighborhood,
  selection,
  getSidebarActiveTab: _getSidebarActiveTab,
  formatEventTitle: _formatEventTitle,
  formatEventSubLineNoPlace: _formatEventSubLineNoPlace,
});

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
