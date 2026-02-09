import { els, state } from '../state.js';
import * as api from '../api.js';
import { formatGrampsDateEnglish, formatGrampsDateEnglishCard } from '../util/date.js';

let _selection = null;
let _loadNeighborhood = null;
let _ensurePeopleIndexLoaded = null;
let _getSidebarActiveTab = null;
let _selectPlaceGlobal = null;
let _resolveRelationsRootPersonId = null;
let _formatEventPlaceForSidebar = null;

export function initDetailPanelFeature({
  selection,
  loadNeighborhood,
  ensurePeopleIndexLoaded,
  getSidebarActiveTab,
  selectPlaceGlobal,
  resolveRelationsRootPersonId,
  formatEventPlaceForSidebar,
} = {}) {
  _selection = selection || null;
  _loadNeighborhood = typeof loadNeighborhood === 'function' ? loadNeighborhood : null;
  _ensurePeopleIndexLoaded = typeof ensurePeopleIndexLoaded === 'function' ? ensurePeopleIndexLoaded : null;
  _getSidebarActiveTab = typeof getSidebarActiveTab === 'function' ? getSidebarActiveTab : null;
  _selectPlaceGlobal = typeof selectPlaceGlobal === 'function' ? selectPlaceGlobal : null;
  _resolveRelationsRootPersonId = typeof resolveRelationsRootPersonId === 'function' ? resolveRelationsRootPersonId : null;
  _formatEventPlaceForSidebar = typeof formatEventPlaceForSidebar === 'function' ? formatEventPlaceForSidebar : null;
}

let _detailPeekTabEl = null;

export function ensureDetailPeekTab() {
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

export function positionDetailPeekTab() {
  const el = ensureDetailPeekTab();
  if (!el || !els.chart) return;
  try {
    const r = els.chart.getBoundingClientRect();
    const top = Math.max(8, (r.top || 0) + 10);
    el.style.top = `${top}px`;
  } catch (_) {}
}

function _updateDetailPeekTab() {
  const el = ensureDetailPeekTab();
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

export function setDetailPeekVisible(visible) {
  const el = ensureDetailPeekTab();
  if (!el) return;
  el.hidden = !visible;
  if (visible) {
    _updateDetailPeekTab();
    positionDetailPeekTab();
  }
}

// --- Person detail panel (floating + draggable) ---
const DETAIL_PANEL_POS_KEY = 'tree_relchart_person_panel_pos_v1';
const DETAIL_PANEL_DEFAULT_POS = { left: 48, top: 72 };

const DETAIL_PANEL_SIZE_KEY = 'tree_relchart_person_panel_size_v1';
const DETAIL_PANEL_DEFAULT_SIZE = { h: 620 };

function _clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function loadDetailPanelPos() {
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

export function applyDetailPanelPos() {
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

export function loadDetailPanelSize() {
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

export function applyDetailPanelSize() {
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

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
}

export function renderPersonDetailPanelSkeleton() {
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

  // Close button
  host.addEventListener('click', (e) => {
    const t = e?.target;
    const el = (t && t.nodeType === 1) ? t : t?.parentElement;
    const closeBtn = el && el.closest ? el.closest('[data-panel-close="1"]') : null;
    if (!closeBtn) return;
    hidePersonDetailPanel();
    e.preventDefault();
    e.stopPropagation();
  });

  // Search popover
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
    try { await Promise.resolve(_ensurePeopleIndexLoaded?.()); } catch (_) {}
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

  // Delegated click handlers
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
      _selection?.selectPerson?.({ apiId, grampsId }, { source: 'detail-search', scrollPeople: false, updateInput: true });
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

    try { _selectPlaceGlobal?.(place, { emitMapEvent: true }); } catch (_) {}
  });

  // Drag behavior
  const header = host.querySelector('[data-panel-drag="1"]');
  if (header) {
    // Prevent Firefox Android pull-to-refresh when dragging the panel down.
    header.addEventListener('touchstart', (e) => {
      const t = e?.target;
      const el = (t && t.nodeType === 1) ? t : t?.parentElement;
      if (el && el.closest && el.closest('[data-panel-close="1"]')) return;
      if (el && el.closest && el.closest('[data-panel-search="1"]')) return;
      if (el && el.closest && el.closest('[data-panel-search-popover="1"]')) return;
      e.preventDefault();
    }, { passive: false });

    header.addEventListener('pointerdown', (e) => {
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
      applyDetailPanelPos();
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
    // Prevent Firefox Android pull-to-refresh when resizing the panel.
    resizeHandle.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });

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
      applyDetailPanelSize();
      applyDetailPanelPos();
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

export function showPersonDetailPanel() {
  const host = els.personDetailPanel;
  if (!host) return;
  state.detailPanel.open = true;
  host.hidden = false;
  setDetailPeekVisible(false);
  applyDetailPanelSize();
  applyDetailPanelPos();
}

export function hidePersonDetailPanel() {
  const host = els.personDetailPanel;
  if (!host) return;
  state.detailPanel.open = false;
  host.hidden = true;
  setDetailPeekVisible(true);
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
      try { setDetailPeekVisible(true); } catch (_) {}
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

  // Gender icon
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
  return { text: '•', title: 'Gender' };
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
  const placeName = _formatEventPlaceForSidebar ? _formatEventPlaceForSidebar(ev) : String(place?.name || '').trim();
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

function _eventTypeRank(typeRaw) {
  const t = String(typeRaw || '').trim().toLowerCase();
  if (!t) return 99;
  if (/\bbirth\b/.test(t)) return 0;
  if (/\bbaptis|\bchristen/.test(t)) return 1;
  if (/\bdeath\b/.test(t)) return 2;
  if (/\bburial\b|\bbury\b|\bcremat/.test(t)) return 3;
  if (/\bmarriage\b|\bwedding\b/.test(t)) return 4;
  return 99;
}

function _sortEventsForPanel(events) {
  const src = Array.isArray(events) ? events : [];
  return src
    .map((ev, idx) => ({ ev, idx, rank: _eventTypeRank(ev?.type) }))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
    .map(x => x.ev);
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
  const parentsByFamily = new Map();
  const childrenByFamily = new Map();
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
  const pid = _resolveRelationsRootPersonId ? _resolveRelationsRootPersonId() : null;
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

      const activeTab = _getSidebarActiveTab ? _getSidebarActiveTab() : null;
      _selection?.selectPerson?.(
        { apiId: apiId || null, grampsId: gid || null },
        { source: 'relations', scrollPeople: activeTab === 'people', updateInput: true },
      );
      if (!gid && apiId) {
        try { els.personId.value = apiId; } catch (_) {}
      }
    });
  }
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

export async function loadPersonDetailsIntoPanel(personApiId, { openPanel = false } = {}) {
  const pid = String(personApiId || '').trim();
  if (!pid) return;

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
    const r = await fetch(api.withPrivacy(`/people/${encodeURIComponent(pid)}/details`));
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
