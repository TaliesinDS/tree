import * as api from './api.js';
import { renderRelationshipChart } from './chart/render.js';
import { mergeGraphPayload } from './chart/payload.js';
import { formatGrampsDateEnglish, formatGrampsDateEnglishCard } from './util/date.js';

const $ = (id) => document.getElementById(id);

const els = {
  personId: $('personId'),
  depth: $('depth'),
  maxNodes: $('maxNodes'),
  loadBtn: $('loadBtn'),
  fitBtn: $('fitBtn'),
  resetBtn: $('resetBtn'),
  status: $('status'),
  chart: $('chart'),
  peopleSearch: $('peopleSearch'),
  peopleSearchClear: $('peopleSearchClear'),
  peopleStatus: $('peopleStatus'),
  peopleList: $('peopleList'),
  peopleExpandToggle: $('peopleExpandToggle'),
  familiesSearch: $('familiesSearch'),
  familiesSearchClear: $('familiesSearchClear'),
  familiesStatus: $('familiesStatus'),
  familiesList: $('familiesList'),
  optPeopleWidePx: $('optPeopleWidePx'),
  optionsMenu: $('optionsMenu'),
  personDetailPanel: $('personDetailPanel'),
};

const state = {
  payload: null,
  selectedPersonId: null,
  panZoom: null,
  people: null,
  peopleLoaded: false,
  peopleSelected: null,
  peopleExpanded: false,
  families: null,
  familiesLoaded: false,
  familiesSelected: null,
  familiesClicksWired: false,
  nodeById: new Map(),
  detailPanel: {
    open: false,
    activeTab: 'details',
    lastPersonId: null,
    lastReqSeq: 0,
    drag: { active: false, dx: 0, dy: 0 },
    resize: { active: false, startY: 0, startH: 0 },
    pos: { left: 48, top: 72 },
    size: { h: null },
    peek: { url: '', name: '' },
  },
};

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
    ph.textContent = name ? name.trim().slice(0, 1).toUpperCase() : '•';
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
  const sel = els.familiesList.querySelector(`.peopleItem[data-family-key="${_cssEscape(key)}"]`);
  if (!sel) return;

  sel.classList.add('selected');
  if (!scroll) return;

  const scrollContainer = els.familiesList;
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
    } catch (_) {
      try { sel.scrollIntoView({ block: 'center' }); } catch (_) {
        try { sel.scrollIntoView(); } catch (_) {}
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

function setSelectedFamilyKey(key, { source = 'unknown', scrollFamilies = true } = {}) {
  const k = String(key || '').trim();
  if (k && state.familiesSelected === k) return;
  state.familiesSelected = k || null;
  if (scrollFamilies) {
    try { _scrollFamiliesToKey(state.familiesSelected); } catch (_) {}
  }
  // Ensure highlighting updates even if the selected row isn't currently rendered.
  try { _renderFamiliesViewport(); } catch (_) {}
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
  // Center the row.
  const top = Math.max(0, idx * _FAMILY_ROW_H - (els.familiesList.clientHeight / 2));
  els.familiesList.scrollTop = top;
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

  // Drag behavior
  const header = host.querySelector('[data-panel-drag="1"]');
  if (header) {
    header.addEventListener('pointerdown', (e) => {
      // Avoid starting a drag when clicking the close button.
      const t = e?.target;
      const el = (t && t.nodeType === 1) ? t : t?.parentElement;
      if (el && el.closest && el.closest('[data-panel-close="1"]')) return;
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
    .filter(([k, v]) => {
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
  const placeName = String(ev?.place?.name || '').trim();
  const desc = String(ev?.description || '').trim();

  const metaParts = [];
  if (dateUi) metaParts.push(dateUi);
  if (placeName) metaParts.push(placeName);
  const meta = metaParts.join(' · ');

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
      ${meta ? `<div class="eventMeta">${_escapeHtml(meta)}</div>` : ''}
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

      // Behave like a global person selection.
      try { _setSidebarActiveTab('people'); } catch (_) {}
      try { ensurePeopleLoaded(); } catch (_) {}

      selection.selectPerson({ apiId: apiId || null, grampsId: gid || null }, { source: 'relations', scrollPeople: true, updateInput: true });
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
    const p = data.person || {};
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

  _setPanelHeader({ name: 'Loading…', meta: pid, gender: null });
  _renderPersonDetailPanelBody();

  try {
    const r = await fetch(`/people/${encodeURIComponent(pid)}/details`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (state.detailPanel.lastReqSeq !== seq) return;
    state.detailPanel.data = data;

    const p = data?.person || {};
    const name = String(p.display_name || 'Person');
    const metaParts = [];
    if (p.gramps_id) metaParts.push(String(p.gramps_id));
    _setPanelHeader({ name, meta: metaParts.join(' · '), portraitUrl: p.portrait_url, gender: p.gender });
    _renderPersonDetailPanelBody();
  } catch (e) {
    if (state.detailPanel.lastReqSeq !== seq) return;
    state.detailPanel.data = { person: { display_name: 'Error' } };
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

function _setPeopleExpanded(expanded, { persist = true, rerender = true } = {}) {
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
  if (rerender && state.peopleLoaded && state.people) {
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
    document.addEventListener('click', (e) => {
      const open = els.optionsMenu.open;
      if (!open) return;
      const t = e.target;
      if (t && els.optionsMenu.contains(t)) return;
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
}

function _cssEscape(s) {
  const v = String(s ?? '');
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
  } catch (_) {}
  return v.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

function _getPeopleOpenGroups() {
  const open = new Set();
  if (!els.peopleList) return open;
  for (const d of els.peopleList.querySelectorAll('details.peopleGroup[open]')) {
    const k = String(d.dataset.groupName || '').trim();
    if (k) {
      open.add(k);
      continue;
    }
    const txt = String(d.querySelector('summary')?.textContent || '').trim();
    const m = txt.match(/^(.*?)(?:\s*\(\d+\)\s*)?$/);
    if (m && m[1]) open.add(m[1].trim());
  }
  return open;
}

function _applyPeopleSelectionToDom({ scroll = true } = {}) {
  if (!els.peopleList) return;
  const key = String(state.peopleSelected || '').trim();

  for (const el of els.peopleList.querySelectorAll('.peopleItem.selected')) {
    el.classList.remove('selected');
  }

  if (!key) return;
  const sel = els.peopleList.querySelector(`.peopleItem[data-person-key="${_cssEscape(key)}"]`);
  if (!sel) return;

  sel.classList.add('selected');
  const group = sel.closest('details.peopleGroup');
  if (group) group.open = true;

  if (!scroll) return;

  // Only the list should scroll (not the whole People panel).
  const scrollContainer = els.peopleList;
  const centerSelected = () => {
    try {
      const c = scrollContainer;
      const cRect = c.getBoundingClientRect();
      const eRect = sel.getBoundingClientRect();
      if (!cRect || !eRect) return;
      const desiredCenter = cRect.top + (cRect.height / 2);
      const currentCenter = eRect.top + (eRect.height / 2);
      const delta = currentCenter - desiredCenter;
      if (!Number.isFinite(delta)) return;
      // Positive delta means the element is below center: scroll down.
      c.scrollTop += delta;
    } catch (_) {
      // Fallback: at least bring it into view.
      try { sel.scrollIntoView({ block: 'center' }); } catch (_) {
        try { sel.scrollIntoView(); } catch (_) {}
      }
    }
  };

  // Let layout settle (opening <details>, rendering list) before centering.
  try {
    requestAnimationFrame(() => {
      centerSelected();
      requestAnimationFrame(centerSelected);
    });
  } catch (_) {
    centerSelected();
  }
}

function setSelectedPersonKey(key, { source = 'unknown', scrollPeople = true } = {}) {
  const k = String(key || '').trim();
  if (k && state.peopleSelected === k) return;
  state.peopleSelected = k || null;

  // Keep the people list selection in sync without rebuilding the list.
  _applyPeopleSelectionToDom({ scroll: scrollPeople });
}

function createSelectionStore() {
  let current = { apiId: null, grampsId: null, key: null };
  const listeners = new Set();

  const notify = (next, meta) => {
    for (const fn of listeners) {
      try { fn(next, meta); } catch (_) {}
    }
  };

  return {
    get() { return current; },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    selectPerson({ apiId, grampsId } = {}, { source = 'unknown', scrollPeople = true, updateInput = true } = {}) {
      const a = String(apiId || '').trim() || null;
      const g = String(grampsId || '').trim() || null;
      const key = (g || a || '').trim() || null;
      const next = { apiId: a, grampsId: g, key };
      const same = (current.apiId === next.apiId) && (current.grampsId === next.grampsId) && (current.key === next.key);
      current = next;
      if (updateInput && next.grampsId) {
        els.personId.value = next.grampsId;
      }
      if (next.key) setSelectedPersonKey(next.key, { source, scrollPeople });
      if (!same) notify(next, { source });
    },
  };
}

const selection = createSelectionStore();

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

  // Avoid redundant fetches.
  if (state.detailPanel.lastPersonId && state.detailPanel.lastPersonId === ref && state.detailPanel.open) return;
  try { loadPersonDetailsIntoPanel(ref, { openPanel: state.detailPanel.open }); } catch (_) {}
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
  const els = Array.from(svg.querySelectorAll(`polygon[${attr}="${pid}"]`));
  if (!els.length) return null;

  // Prefer the visible tab (it contains a <title>).
  const withTitle = els.find(el => !!el.querySelector('title'));
  return withTitle || els[0] || null;
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
    // The rim overlay uses a relatively large corner radius; our outline should be a bit larger
    // than the geometric fallback so it visually aligns.
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
  els.status.textContent = String(msg ?? '');
  els.status.title = String(msg ?? '');
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
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
    container: els.chart,
    payload: state.payload,
    onSelectPerson: (pid) => {
      state.selectedPersonId = pid;
      try {
        const svg = els.chart?.querySelector('svg');
        _applyGraphPersonSelection(svg, pid);
      } catch (_) {}

      // Update detail data (and peek tab) without forcing the panel open.
      try { loadPersonDetailsIntoPanel(pid, { openPanel: state.detailPanel.open }); } catch (_) {}

      const node = state.nodeById.get(String(pid)) || null;
      // Graph click should behave like a global selection: switch to People and center-scroll.
      _setSidebarActiveTab('people');
      ensurePeopleLoaded();
      selection.selectPerson({ apiId: pid, grampsId: node?.gramps_id }, { source: 'graph', scrollPeople: true, updateInput: true });
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
    const svg = els.chart?.querySelector('svg');
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

    let resolvedApiId = directHit?.id ? String(directHit.id) : null;
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
    selection.selectPerson(
      {
        apiId: state.selectedPersonId || null,
        grampsId: resolvedGrampsId || (looksLikeGrampsId ? requested : null),
      },
      { source: 'load', scrollPeople: true, updateInput: true },
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
  els.chart.innerHTML = '';
  setStatus('Ready.');
});

els.fitBtn.addEventListener('click', () => {
  state.panZoom?.reset?.();
});

// Initial
setStatus('Ready.');
_initPeopleExpanded();

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

function _displayPersonLabel(p) {
  const name = String(p?.display_name || '');
  const gid = String(p?.gramps_id || '').trim();
  return gid ? `${name} (${gid})` : name;
}

function _surnameGroupKey(surnameRaw) {
  const raw = String(surnameRaw || '').trim();
  if (!raw || raw === '?') return 'No surname';

  // Normalize apostrophes/punctuation for matching particles, but keep original
  // casing for the returned group label.
  const parts = raw.split(/\s+/g).filter(Boolean);
  if (!parts.length) return raw;

  const particles = new Set([
    // Dutch
    'van', 'v', 'vd', 'vander', 'vander', 'vanden', 'vanden', 'ten', 'ter', 'te', 't', "'t",
    'der', 'den', 'de', 'het',
    // German
    'von', 'zu', 'zum', 'zur',
    // French/Spanish/Portuguese/Italian (common)
    'da', 'das', 'do', 'dos', 'di', 'del', 'della', 'des', 'du', 'la', 'le', 'las', 'los',
    // English/other
    'of', 'the',
  ]);

  let i = 0;
  while (i < parts.length) {
    const tokenOrig = parts[i];
    const tokenNorm = String(tokenOrig)
      .toLowerCase()
      .replace(/[\u2019\u0060]/g, "'")
      .replace(/[.·]/g, '')
      .replace(/[\\/]/g, '')
      .trim();

    // Handle d'Artagnan / l'Overture style names: group by the part after d'/l'.
    if (i === 0 && (tokenNorm.startsWith("d'") || tokenNorm.startsWith("l'"))) {
      const remainder = tokenOrig.slice(2).trim();
      if (remainder) {
        parts[i] = remainder;
      } else {
        i++;
      }
      break;
    }

    if (particles.has(tokenNorm)) {
      i++;
      continue;
    }
    break;
  }

  const remaining = parts.slice(i).filter(Boolean);
  if (!remaining.length) return raw;
  return remaining.join(' ');
}

function _surnameGroupLabel(p) {
  return _surnameGroupKey(p?.surname);
}

function _renderPeopleList(people, query) {
  if (!els.peopleList) return;

  const openGroups = _getPeopleOpenGroups();

  const q = _normKey(query);
  const filtered = q
    ? people.filter((p) => _normKey(_displayPersonLabel(p)).includes(q))
    : people;

  const groups = new Map();
  for (const p of filtered) {
    const k = _surnameGroupLabel(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  // Force No surname group at top.
  const noSurnameIdx = groupNames.indexOf('No surname');
  if (noSurnameIdx > 0) {
    groupNames.splice(noSurnameIdx, 1);
    groupNames.unshift('No surname');
  }

  els.peopleList.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const groupName of groupNames) {
    const peopleInGroup = groups.get(groupName) || [];
    const details = document.createElement('details');
    details.className = 'peopleGroup';
    details.dataset.groupName = groupName;

    const summary = document.createElement('summary');
    summary.textContent = `${groupName} (${peopleInGroup.length})`;
    details.appendChild(summary);

    let groupHasSelection = false;
    for (const p of peopleInGroup) {
      const key = String(p?.gramps_id || p?.id || '').trim();
      if (key && state.peopleSelected && key === state.peopleSelected) {
        groupHasSelection = true;
        break;
      }
    }
    details.open = openGroups.has(groupName) || groupHasSelection;

    for (const p of peopleInGroup) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'peopleItem';

      const key = String(p?.gramps_id || p?.id || '').trim();
      btn.dataset.personKey = key;
      if (state.peopleSelected && state.peopleSelected === key) {
        btn.classList.add('selected');
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = String(p?.display_name || '');

      const metaRow = document.createElement('div');
      metaRow.className = 'metaRow';

      if (state.peopleExpanded) {
        const by = p?.birth_year;
        const dy = p?.death_year;
        const hasBy = (typeof by === 'number') && Number.isFinite(by);
        const hasDy = (typeof dy === 'number') && Number.isFinite(dy);

        // Always render the dates block in expanded mode so IDs align.
        // Use fixed-width sub-spans so:
        // - missing death => "563 -     I1221" (no leading spaces)
        // - missing birth => "    - 1060 I1221"
        const datesBlock = document.createElement('span');
        datesBlock.className = 'datesBlock';

        const birthEl = document.createElement('span');
        birthEl.className = 'dateBirth';
        birthEl.textContent = hasBy ? String(by) : '';

        const dashEl = document.createElement('span');
        dashEl.className = 'dateDash';
        dashEl.textContent = (hasBy || hasDy) ? ' - ' : '';

        const deathEl = document.createElement('span');
        deathEl.className = 'dateDeath';
        deathEl.textContent = hasDy ? String(dy) : '';

        datesBlock.appendChild(birthEl);
        datesBlock.appendChild(dashEl);
        datesBlock.appendChild(deathEl);

        metaRow.appendChild(datesBlock);
      }

      const metaEl = document.createElement('span');
      metaEl.className = 'meta';
      metaEl.textContent = String(p?.gramps_id || p?.id || '');
      metaRow.appendChild(metaEl);

      btn.appendChild(nameEl);
      btn.appendChild(metaRow);

      btn.addEventListener('click', async () => {
        const ref = String(p?.gramps_id || p?.id || '').trim();
        if (!ref) return;
        selection.selectPerson({ grampsId: ref }, { source: 'people-list', scrollPeople: false, updateInput: true });
        await loadNeighborhood();
      });

      details.appendChild(btn);
    }

    frag.appendChild(details);
  }

  frag && els.peopleList.appendChild(frag);

  // Ensure the DOM reflects the current selection and expands the selected group
  // (without collapsing any other groups the user opened).
  _applyPeopleSelectionToDom({ scroll: false });

  if (els.peopleStatus) {
    els.peopleStatus.textContent = `Showing ${filtered.length} of ${people.length}.`;
  }
}

async function ensurePeopleLoaded() {
  if (state.peopleLoaded) return;
  if (!els.peopleStatus || !els.peopleList) return;

  els.peopleStatus.textContent = 'Loading people…';
  try {
    // 50k hard limit on the endpoint; typical trees are much smaller (you have ~4k).
    const r = await fetch('/people?limit=50000&offset=0');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    state.people = results;
    state.peopleLoaded = true;
    _renderPeopleList(results, els.peopleSearch?.value || '');
    // In case a person was selected from the graph before the People tab loaded.
    _applyPeopleSelectionToDom({ scroll: true });
  } catch (e) {
    els.peopleStatus.textContent = `Failed to load people: ${e?.message || e}`;
  }
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

// Load people list lazily when the People tab is opened.
const peopleTabBtn = document.querySelector('.tabbtn[data-tab="people"]');
if (peopleTabBtn) {
  peopleTabBtn.addEventListener('click', () => {
    ensurePeopleLoaded();
  });
}

// Load families list lazily when the Families tab is opened.
const familiesTabBtn = document.querySelector('.tabbtn[data-tab="families"]');
if (familiesTabBtn) {
  familiesTabBtn.addEventListener('click', () => {
    ensureFamiliesLoaded();
  });
}

if (els.peopleSearch) {
  const updateClearVisibility = () => {
    if (!els.peopleSearchClear) return;
    const has = String(els.peopleSearch.value || '').length > 0;
    els.peopleSearchClear.style.display = has ? 'inline-flex' : 'none';
  };

  const doRerender = () => {
    if (!state.peopleLoaded || !state.people) return;
    _renderPeopleList(state.people, els.peopleSearch.value);
  };

  els.peopleSearch.addEventListener('input', () => {
    updateClearVisibility();
    doRerender();
  });

  els.peopleSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.peopleSearch.value) return;
      els.peopleSearch.value = '';
      updateClearVisibility();
      doRerender();
      try { els.peopleSearch.focus(); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    }
  });

  if (els.peopleSearchClear) {
    els.peopleSearchClear.addEventListener('click', () => {
      if (!els.peopleSearch) return;
      if (!els.peopleSearch.value) return;
      els.peopleSearch.value = '';
      updateClearVisibility();
      doRerender();
      try { els.peopleSearch.focus(); } catch (_) {}
    });
  }

  // Initial state
  updateClearVisibility();
}

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
