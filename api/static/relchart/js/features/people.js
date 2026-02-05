import { els, state } from '../state.js';
import { _cssEscape } from '../util/dom.js';

export function initPeopleFeature() {

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
}

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

export function _applyPeopleSelectionToDom({ scroll = true } = {}) {
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
    } catch (_err) {
      // Fallback: at least bring it into view.
      try { sel.scrollIntoView({ block: 'center' }); } catch (_err2) {
        try { sel.scrollIntoView(); } catch (_err3) {}
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

export function setSelectedPersonKey(key, { source: _source = 'unknown', scrollPeople = true } = {}) {
  const k = String(key || '').trim();
  if (k && state.peopleSelected === k) return;
  state.peopleSelected = k || null;

  // Keep the people list selection in sync without rebuilding the list.
  _applyPeopleSelectionToDom({ scroll: scrollPeople });
}

export function createSelectionStore() {
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
      if (updateInput && next.grampsId && els.personId) {
        els.personId.value = next.grampsId;
      }
      if (next.key) setSelectedPersonKey(next.key, { source, scrollPeople });
      if (!same) notify(next, { source });
    },
  };
}

export const selection = createSelectionStore();

export function _renderPeopleList(people, query) {
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
      });

      details.appendChild(btn);
    }

    frag.appendChild(details);
  }

  frag && els.peopleList.appendChild(frag);

  // Ensure the DOM reflects the current selection and expands the selected group.
  _applyPeopleSelectionToDom({ scroll: false });

  if (els.peopleStatus) {
    els.peopleStatus.textContent = `Showing ${filtered.length} of ${people.length}.`;
  }
}

export async function ensurePeopleLoaded() {
  if (!els.peopleStatus || !els.peopleList) return;

  if (!state.peopleLoaded) {
    els.peopleStatus.textContent = 'Loading people…';
  }
  try {
    await ensurePeopleIndexLoaded();
    const results = Array.isArray(state.people) ? state.people : [];
    _renderPeopleList(results, els.peopleSearch?.value || '');
    // In case a person was selected from the graph before the People tab loaded.
    _applyPeopleSelectionToDom({ scroll: true });
  } catch (e) {
    els.peopleStatus.textContent = `Failed to load people: ${e?.message || e}`;
  }
}

let _peopleIndexPromise = null;

export async function ensurePeopleIndexLoaded() {
  if (state.peopleLoaded) return;
  if (_peopleIndexPromise) return _peopleIndexPromise;

  _peopleIndexPromise = (async () => {
    // 50k hard limit on the endpoint; typical trees are much smaller (you have ~4k).
    const r = await fetch('/people?limit=50000&offset=0');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    state.people = results;
    state.peopleLoaded = true;
  })();

  try {
    await _peopleIndexPromise;
  } finally {
    _peopleIndexPromise = null;
  }
}
