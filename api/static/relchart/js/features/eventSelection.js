import { els, state } from '../state.js';
import { _cssEscape } from '../util/dom.js';

export function _applyEventsSelectionToDom({ scroll = true } = {}) {
  if (!els.eventsList) return;
  const id = String(state.eventsSelected || '').trim();

  for (const el of els.eventsList.querySelectorAll('.eventsItem.selected')) {
    el.classList.remove('selected');
  }

  if (!id) return;
  const sel = els.eventsList.querySelector(`.eventsItem[data-event-id="${_cssEscape(id)}"]`);
  if (!sel) return;

  sel.classList.add('selected');

  if (!scroll) return;

  try {
    sel.scrollIntoView({ block: 'center' });
  } catch (_) {
    try { sel.scrollIntoView(); } catch (_err2) {}
  }
}

export function setSelectedEventId(id, { source: _source = 'unknown', scrollEvents = true } = {}) {
  const k = String(id || '').trim();
  if (k && state.eventsSelected === k) return;
  state.eventsSelected = k || null;
  _applyEventsSelectionToDom({ scroll: scrollEvents });
}

export function createEventSelectionStore() {
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
    selectEvent({ apiId, grampsId } = {}, { source = 'unknown', scrollEvents = true } = {}) {
      const a = String(apiId || '').trim() || null;
      const g = String(grampsId || '').trim() || null;
      const key = (a || g || '').trim() || null;
      const next = { apiId: a, grampsId: g, key };
      const same = (current.apiId === next.apiId) && (current.grampsId === next.grampsId) && (current.key === next.key);
      current = next;
      if (next.key) setSelectedEventId(next.key, { source, scrollEvents });
      if (!same) notify(next, { source });
    },
  };
}

export const eventSelection = createEventSelectionStore();
