import { els } from '../state.js';
import * as api from '../api.js';

let _eventSelection = null;
let _personSelection = null;

let _textPopoverEl = null;
let _textPopoverAnchorEl = null;
let _textPopoverWired = false;

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

function _ensureTextPopover() {
  if (_textPopoverEl && _textPopoverEl.isConnected) return _textPopoverEl;

  const host = document.createElement('div');
  host.className = 'eventTextPopover';
  host.hidden = true;
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'false');
  host.setAttribute('aria-label', 'Full text');

  host.innerHTML = `
    <div class="eventTextPopoverHeader">
      <div class="eventTextPopoverTitle" data-etp-title="1">Text</div>
      <div class="eventTextPopoverHint" aria-hidden="true">click outside to close</div>
    </div>
    <div class="eventTextPopoverBody" data-etp-body="1"></div>
  `;

  try { document.body.appendChild(host); } catch (_) {}
  _textPopoverEl = host;

  if (!_textPopoverWired) {
    _textPopoverWired = true;

    document.addEventListener('pointerdown', (e) => {
      if (!_textPopoverEl || _textPopoverEl.hidden) return;
      const t = e?.target;
      if (t && _textPopoverEl.contains(t)) return;
      if (_textPopoverAnchorEl && t && _textPopoverAnchorEl.contains?.(t)) return;
      _closeTextPopover();
    }, { capture: true });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!_textPopoverEl || _textPopoverEl.hidden) return;
      _closeTextPopover();
    });

    window.addEventListener('resize', () => {
      if (!_textPopoverEl || _textPopoverEl.hidden) return;
      try { _positionTextPopover(_textPopoverAnchorEl); } catch (_) {}
    });
  }

  return host;
}

function _closeTextPopover() {
  if (!_textPopoverEl) return;
  _textPopoverEl.hidden = true;
  _textPopoverAnchorEl = null;
}

function _positionTextPopover(anchorEl) {
  if (!_textPopoverEl || _textPopoverEl.hidden) return;
  if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return;

  const r = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;

  const gap = 10;
  const desiredW = 520;
  const maxW = Math.max(280, Math.min(640, vw - (gap * 2)));
  const w = Math.min(desiredW, maxW);

  // Prefer opening to the right of the sidebar.
  let left = r.right + gap;
  if (left + w > vw - gap) {
    // Fallback: open to the left.
    left = Math.max(gap, r.left - gap - w);
  }

  const top = Math.max(gap, Math.min(vh - gap - 120, r.top));

  _textPopoverEl.style.left = `${Math.round(left)}px`;
  _textPopoverEl.style.top = `${Math.round(top)}px`;
  _textPopoverEl.style.width = `${Math.round(w)}px`;
  _textPopoverEl.style.maxHeight = `${Math.round(vh - top - gap)}px`;
}

function _openTextPopover({ title, text, anchorEl } = {}) {
  const t = _text(title) || 'Text';
  const body = String(text ?? '');
  if (!body.trim()) return;
  const host = _ensureTextPopover();
  const titleEl = host.querySelector('[data-etp-title="1"]');
  const bodyEl = host.querySelector('[data-etp-body="1"]');
  if (titleEl) titleEl.textContent = t;
  if (bodyEl) bodyEl.textContent = body;

  host.hidden = false;
  _textPopoverAnchorEl = anchorEl || null;
  try { _positionTextPopover(anchorEl); } catch (_) {}
}

function _toggleTextPopover(opts) {
  const host = _ensureTextPopover();
  const nextTitle = _text(opts?.title) || 'Text';
  const nextText = String(opts?.text ?? '');
  const nextAnchor = opts?.anchorEl || null;

  const curTitle = _text(host.querySelector('[data-etp-title="1"]')?.textContent);
  const curBody = String(host.querySelector('[data-etp-body="1"]')?.textContent ?? '');
  const isSame = !host.hidden && curTitle === nextTitle && curBody === nextText && _textPopoverAnchorEl === nextAnchor;
  if (isSame) {
    _closeTextPopover();
    return;
  }

  _openTextPopover({ title: nextTitle, text: nextText, anchorEl: nextAnchor });
}

function _renderSectionHeader({ title, onMenuClick, menuTitle } = {}) {
  const row = document.createElement('div');
  row.className = 'eventDetailSectionHeader';

  const t = document.createElement('div');
  t.className = 'eventDetailSectionTitle';
  t.textContent = _text(title);
  row.appendChild(t);

  if (typeof onMenuClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eventDetailMenuBtn';
    btn.title = _text(menuTitle) || 'Show full text';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = '<span class="placesMenuIcon" aria-hidden="true"></span>';
    btn.addEventListener('click', (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      try { onMenuClick(btn); } catch (_) {}
    });
    row.appendChild(btn);
  }

  return row;
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
    head.appendChild(_renderSectionHeader({
      title: 'Description',
      menuTitle: 'Show full description',
      onMenuClick: (anchorEl) => {
        _toggleTextPopover({
          title: 'Description',
          text: desc,
          anchorEl,
        });
      },
    }));

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
  const notesText = notes
    .map((n) => _text(n?.body))
    .filter(Boolean)
    .join('\n\n—\n\n');

  els.eventDetailPanel.appendChild(_renderSectionHeader({
    title: `Notes (${notes.length})`,
    menuTitle: 'Show full notes',
    onMenuClick: notesText
      ? (anchorEl) => {
          _toggleTextPopover({
            title: `Notes (${notes.length})`,
            text: notesText,
            anchorEl,
          });
        }
      : null,
  }));

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
