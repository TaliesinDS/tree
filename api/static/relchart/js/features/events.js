import { els, state } from '../state.js';
import { eventSelection as _globalEventSelection } from './eventSelection.js';

let _selection = null;
let _eventSelection = null;
let _loadNeighborhood = null;
let _setStatus = null;
let _copyToClipboard = null;
let _getSidebarActiveTab = null;

let _formatEventTitle = null;
let _formatEventSubLine = null;

let _eventsSearchTimer = null;
let _eventsScrollTimer = null;

export function initEventsFeature({
  selection,
  eventSelection,
  loadNeighborhood,
  setStatus,
  copyToClipboard,
  getSidebarActiveTab,
  formatEventTitle,
  formatEventSubLine,
} = {}) {
  _selection = selection || null;
  _eventSelection = eventSelection || _globalEventSelection || null;
  _loadNeighborhood = typeof loadNeighborhood === 'function' ? loadNeighborhood : null;
  _setStatus = typeof setStatus === 'function' ? setStatus : null;
  _copyToClipboard = typeof copyToClipboard === 'function' ? copyToClipboard : null;
  _getSidebarActiveTab = typeof getSidebarActiveTab === 'function' ? getSidebarActiveTab : null;

  _formatEventTitle = typeof formatEventTitle === 'function' ? formatEventTitle : (ev) => String(ev?.type || ev?.event_type || 'Event').trim() || 'Event';
  _formatEventSubLine = typeof formatEventSubLine === 'function' ? formatEventSubLine : (ev) => String(ev?.date || ev?.date_text || '').trim();

  _wireSearch();
  _wireSort();
  _wireInfiniteScroll();
}

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
}

function _eventGrampsId(ev) {
  const g = String(ev?.gramps_id || '').trim();
  return g || '';
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
      if (ha !== hb) return ha ? -1 : 1;
      if (ha && hb && ya !== yb) return (ya - yb) * dir;
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

    const c = cmpStr(a?.type, b?.type);
    if (c) return c * dir;
    const y = (_eventYearHint(a) ?? 999999) - (_eventYearHint(b) ?? 999999);
    if (y) return y;
    return cmpStr(_eventGrampsId(a) || a?.id, _eventGrampsId(b) || b?.id);
  });

  return out;
}

export function renderEventsList(events, query) {
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
        return _normKey(`${title} ${sub} ${desc} ${gid} ${apiId} ${primaryName} ${primaryGid} ${primaryApiId}`).includes(qn);
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

    const r1l = document.createElement('div');
    r1l.className = 'eventType';
    r1l.textContent = _formatEventTitle(ev);

    const primary = ev?.primary_person || null;
    const primaryName = String(primary?.display_name || '').trim();
    const r1r = document.createElement('div');
    r1r.className = 'eventPrimary';
    r1r.textContent = primaryName || '';
    if (primaryName) r1r.title = primaryName;

    const r2l = document.createElement('div');
    r2l.className = 'eventMetaLeft';
    r2l.textContent = _formatEventSubLine(ev);

    const r2r = document.createElement('div');
    r2r.className = 'eventMetaRight';
    r2r.textContent = gid || apiId;

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
      r3.style.gridColumn = '1 / -1';
      grid.appendChild(r3);
    }

    btn.appendChild(grid);

    btn.addEventListener('click', () => {
      if (!apiId) return;
      const activeTab = _getSidebarActiveTab ? _getSidebarActiveTab() : null;
      try {
        _eventSelection?.selectEvent?.(
          { apiId: apiId || null, grampsId: gid || null },
          { source: 'events-list', scrollEvents: activeTab === 'events' },
        );
      } catch (_) {
        // Fallback (shouldn't happen): keep UI selection stable.
        state.eventsSelected = apiId;
        try {
          for (const el of els.eventsList.querySelectorAll('.eventsItem.selected')) el.classList.remove('selected');
          btn.classList.add('selected');
        } catch (_) {}
      }

      const primaryName = String(primary?.display_name || '').trim();
      const msg = primaryName ? `Event selected: ${gid || apiId} · ${primaryName}` : `Event selected: ${gid || apiId}`;
      _setStatus?.(msg);

      // Keep the previous convenience behavior: for events without a primary person,
      // copy IDs so the user can quickly inspect/debug.
      if (!primaryName) {
        Promise.resolve(_copyToClipboard?.(`event_id=${apiId}${gid ? `\ngramps_id=${gid}` : ''}`)).then((ok) => {
          if (ok) _setStatus?.(msg + ' (copied)');
        }).catch(() => {});
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

export async function ensureEventsLoaded() {
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

    renderEventsList(state.events, '');
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
    renderEventsList(state.events, '');
  } catch (_) {
    // Ignore; keep existing results.
  } finally {
    if (seq === state.eventsReqSeq) state.eventsLoading = false;
  }
}

function _wireSearch() {
  if (!els.eventsSearch) return;

  const updateClearVisibility = () => {
    if (!els.eventsSearchClear) return;
    const has = String(els.eventsSearch.value || '').length > 0;
    els.eventsSearchClear.style.display = has ? 'inline-flex' : 'none';
  };

  const scheduleReload = () => {
    if (_eventsSearchTimer) clearTimeout(_eventsSearchTimer);
    _eventsSearchTimer = setTimeout(() => {
      state.eventsQuery = String(els.eventsSearch.value || '').trim();
      if (state.eventsServerMode) {
        state.eventsLoaded = false;
        ensureEventsLoaded();
      } else {
        if (!state.eventsLoaded || !state.events) return;
        renderEventsList(state.events, els.eventsSearch.value);
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

function _wireSort() {
  if (!els.eventsSort) return;
  try { els.eventsSort.value = String(state.eventsSort || 'type_asc'); } catch (_) {}

  els.eventsSort.addEventListener('change', () => {
    state.eventsSort = String(els.eventsSort.value || 'type_asc');
    if (state.eventsServerMode) {
      state.eventsLoaded = false;
      ensureEventsLoaded();
    } else {
      if (!state.eventsLoaded || !state.events) return;
      renderEventsList(state.events, els.eventsSearch?.value || '');
    }
  });
}

function _wireInfiniteScroll() {
  if (!els.eventsList) return;
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
