import { els, state } from '../state.js';
import * as api from '../api.js';
import { _cssEscape } from '../util/dom.js';
import { formatGrampsDateEnglishCard } from '../util/date.js';

let _setStatus = null;
let _selection = null;

export function initFamiliesFeature({ setStatus, selection } = {}) {
  _setStatus = typeof setStatus === 'function' ? setStatus : null;
  _selection = selection || null;

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
}

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
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

export function _applyFamiliesSelectionToDom({ scroll = true } = {}) {
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

export function setSelectedFamilyKey(key, { source: _source = 'unknown', scrollFamilies = true } = {}) {
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

export function _renderFamiliesList(families, query) {
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
      try { _setStatus?.('Cannot load family: parents are not available.', true); } catch (_) {}
      return;
    }

    const looksLikeGrampsId = /^I\d+$/i.test(seed);
    try {
      _selection?.selectPerson?.(
        { apiId: looksLikeGrampsId ? null : seed, grampsId: looksLikeGrampsId ? seed : null },
        { source: 'families-list', scrollPeople: false, updateInput: true },
      );
    } catch (_err) {
      // Fallback: set the input; global selection/load should handle the rest.
      try { if (els.personId) els.personId.value = seed; } catch (_err2) {}
    }
  });
}

export async function ensureFamiliesLoaded() {
  if (state.familiesLoaded) return;
  if (!els.familiesStatus || !els.familiesList) return;

  els.familiesStatus.textContent = 'Loading families…';
  try {
    _wireFamiliesClicks();
    const r = await fetch(api.withPrivacy('/families?limit=50000&offset=0'));
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
