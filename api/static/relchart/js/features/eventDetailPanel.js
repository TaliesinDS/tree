import { els } from '../state.js';
import * as api from '../api.js';

let _eventSelection = null;
let _personSelection = null;

export function initEventDetailPanelFeature({ eventSelection, selection } = {}) {
  _eventSelection = eventSelection || null;
  _personSelection = selection || null;

  if (!els.eventDetailPanel) return;

  renderEmpty();

  if (_eventSelection?.subscribe) {
    _eventSelection.subscribe((next) => {
      const id = String(next?.apiId || '').trim();
      if (!id) {
        renderEmpty();
        return;
      }
      renderLoading(id);
      _loadAndRender(id);
    });
  }
}

let _reqSeq = 0;

async function _loadAndRender(eventId) {
  const seq = ++_reqSeq;
  try {
    const data = await api.eventDetails({ eventId });
    if (seq !== _reqSeq) return;
    renderEvent(data);
  } catch (e) {
    if (seq !== _reqSeq) return;
    renderError(e);
  }
}

function _text(v) {
  return String(v ?? '').trim();
}

function _eventIdLabel(ev) {
  const gid = _text(ev?.gramps_id);
  const id = _text(ev?.id);
  return gid || id || '';
}

function _eventMeta(ev) {
  const date = _text(ev?.date_text) || _text(ev?.date);
  const placeName = _text(ev?.place?.name);
  const parts = [];
  if (date) parts.push(date);
  if (placeName) parts.push(placeName);
  return parts.join(' · ');
}

export function renderEmpty() {
  if (!els.eventDetailPanel) return;
  els.eventDetailPanel.innerHTML = '';

  const d = document.createElement('div');
  d.className = 'eventDetailEmpty';
  d.textContent = 'Select an event to see details.';
  els.eventDetailPanel.appendChild(d);
}

function renderLoading(eventId) {
  if (!els.eventDetailPanel) return;
  els.eventDetailPanel.innerHTML = '';

  const head = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'eventDetailTitleRow';

  const t = document.createElement('div');
  t.className = 'eventDetailType';
  t.textContent = 'Loading…';

  const id = document.createElement('div');
  id.className = 'eventDetailId';
  id.textContent = _text(eventId);

  row.appendChild(t);
  row.appendChild(id);
  head.appendChild(row);
  els.eventDetailPanel.appendChild(head);
}

function renderError(e) {
  if (!els.eventDetailPanel) return;
  els.eventDetailPanel.innerHTML = '';

  const d = document.createElement('div');
  d.className = 'eventDetailEmpty';
  d.textContent = `Failed to load event details: ${_text(e?.message || e)}`;
  els.eventDetailPanel.appendChild(d);
}

function renderEvent(ev) {
  if (!els.eventDetailPanel) return;
  els.eventDetailPanel.innerHTML = '';

  const head = document.createElement('div');

  const titleRow = document.createElement('div');
  titleRow.className = 'eventDetailTitleRow';

  const typeEl = document.createElement('div');
  typeEl.className = 'eventDetailType';
  typeEl.textContent = _text(ev?.type) || 'Event';

  const idEl = document.createElement('div');
  idEl.className = 'eventDetailId';
  idEl.textContent = _eventIdLabel(ev);

  titleRow.appendChild(typeEl);
  titleRow.appendChild(idEl);
  head.appendChild(titleRow);

  const meta = _eventMeta(ev);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'eventDetailMeta';
    metaEl.textContent = meta;
    head.appendChild(metaEl);
  }

  const desc = _text(ev?.description);
  if (desc) {
    const descEl = document.createElement('div');
    descEl.className = 'eventDetailDesc';
    descEl.textContent = desc;
    head.appendChild(descEl);
  }

  els.eventDetailPanel.appendChild(head);

  // References
  const people = Array.isArray(ev?.people) ? ev.people : [];
  const refTitle = document.createElement('div');
  refTitle.className = 'eventDetailSectionTitle';
  refTitle.textContent = `References (${people.length})`;
  els.eventDetailPanel.appendChild(refTitle);

  if (people.length) {
    const list = document.createElement('div');
    list.className = 'eventRefList';

    for (const p of people) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'eventRefPerson';

      const top = document.createElement('div');
      top.className = 'eventRefTop';

      const name = document.createElement('div');
      name.className = 'eventRefName';
      name.textContent = _text(p?.display_name) || 'Person';

      const role = _text(p?.role);
      const roleEl = document.createElement('div');
      roleEl.className = 'eventRefRole';
      roleEl.textContent = role;

      top.appendChild(name);
      top.appendChild(roleEl);

      const metaEl = document.createElement('div');
      metaEl.className = 'eventRefMeta';
      metaEl.textContent = _text(p?.gramps_id) || _text(p?.id);

      btn.appendChild(top);
      btn.appendChild(metaEl);

      btn.addEventListener('click', () => {
        const apiId = _text(p?.id) || null;
        const grampsId = _text(p?.gramps_id) || null;
        try {
          _personSelection?.selectPerson?.({ apiId, grampsId }, { source: 'event-detail', scrollPeople: false, updateInput: true });
        } catch (_) {}
      });

      list.appendChild(btn);
    }

    els.eventDetailPanel.appendChild(list);
  } else {
    const none = document.createElement('div');
    none.className = 'eventDetailEmpty';
    none.textContent = 'No people linked to this event.';
    els.eventDetailPanel.appendChild(none);
  }

  // Notes
  const notes = Array.isArray(ev?.notes) ? ev.notes : [];
  const notesTitle = document.createElement('div');
  notesTitle.className = 'eventDetailSectionTitle';
  notesTitle.textContent = `Notes (${notes.length})`;
  els.eventDetailPanel.appendChild(notesTitle);

  if (notes.length) {
    const list = document.createElement('div');
    list.className = 'noteList';
    for (const n of notes) {
      const item = document.createElement('div');
      item.className = 'noteItem';
      item.textContent = _text(n?.body);
      list.appendChild(item);
    }
    els.eventDetailPanel.appendChild(list);
  } else {
    const none = document.createElement('div');
    none.className = 'eventDetailEmpty';
    none.textContent = 'No notes.';
    els.eventDetailPanel.appendChild(none);
  }
}
