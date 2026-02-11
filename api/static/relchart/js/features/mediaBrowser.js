/**
 * Media browser — full-screen overlay opened from the topbar "Media" button.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │  Media Browser                          [✕]  │
 *   ├──────────────┬───────────────────────────────┤
 *   │  Filters     │   Thumbnail Grid              │
 *   │  Search      │                               │
 *   │  Sort        │                               │
 *   │              │                               │
 *   │ ─ Selected ─ │                               │
 *   │  [preview]   │                               │
 *   │  metadata    │                               │
 *   │  refs        │                               │
 *   └──────────────┴───────────────────────────────┘
 */

import * as api from '../api.js';
import { showMediaOverlay } from './mediaOverlay.js';

let _overlayEl = null;
let _media = [];
let _total = 0;
let _offset = 0;
let _selectedId = null;
let _selectedDetail = null;
let _loading = false;

// Filter state
let _filterQ = '';
let _filterSort = 'gramps_id_asc';

const PAGE_SIZE = 100;

// ─── Public API ───

let _loadNeighborhood = null;

export function initMediaBrowserFeature({ loadNeighborhood } = {}) {
  _loadNeighborhood = loadNeighborhood || null;
  const btn = document.getElementById('mediaBtn');
  if (btn) btn.addEventListener('click', openMediaBrowser);
}

export async function openMediaBrowser() {
  _media = [];
  _total = 0;
  _offset = 0;
  _selectedId = null;
  _selectedDetail = null;

  const el = _ensureOverlay();
  el.hidden = false;
  el.tabIndex = 0;
  el.focus();
  _renderSidebar();
  _renderGrid();
  await _loadPage(0);
}

export function closeMediaBrowser() {
  if (_overlayEl) _overlayEl.hidden = true;
  _media = [];
  _selectedId = null;
  _selectedDetail = null;
}

// ─── Overlay creation ───

function _ensureOverlay() {
  if (_overlayEl && _overlayEl.isConnected) return _overlayEl;
  const existing = document.getElementById('mediaBrowserOverlay');
  if (existing) { _overlayEl = existing; return existing; }

  const el = document.createElement('div');
  el.id = 'mediaBrowserOverlay';
  el.className = 'mbOverlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="mbBackdrop" data-mb-close="1"></div>
    <div class="mbContent">
      <div class="mbHeader">
        <span class="mbTitle">Media Browser</span>
        <button class="mbCloseBtn" data-mb-close="1" type="button" title="Close">×</button>
      </div>
      <div class="mbBody">
        <div class="mbSidebar" data-mb-sidebar="1"></div>
        <div class="mbMain">
          <div class="mbGrid" data-mb-grid="1"></div>
          <div class="mbLoadMore" data-mb-loadmore="1" hidden>
            <button type="button" class="miniToggle">Load more…</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Events
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-mb-close="1"]')) { closeMediaBrowser(); return; }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMediaBrowser(); e.preventDefault(); }
  });

  // Load more button
  const loadMoreBtn = el.querySelector('[data-mb-loadmore="1"] button');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => _loadPage(_offset + PAGE_SIZE));
  }

  document.body.appendChild(el);
  _overlayEl = el;
  return el;
}

// ─── Data loading ───

async function _loadPage(offset) {
  if (_loading) return;
  _loading = true;

  try {
    const res = await api.fetchMediaList({
      limit: PAGE_SIZE,
      offset,
      q: _filterQ || undefined,
      sort: _filterSort,
    });
    const results = Array.isArray(res?.results) ? res.results : [];
    _total = res?.total ?? 0;

    if (offset === 0) {
      _media = results;
    } else {
      _media = _media.concat(results);
    }
    _offset = offset;

    _renderGrid();
    _updateLoadMore();
  } catch (e) {
    console.error('Media browser: load failed', e);
  } finally {
    _loading = false;
  }
}

function _updateLoadMore() {
  const el = _overlayEl;
  if (!el) return;
  const wrap = el.querySelector('[data-mb-loadmore="1"]');
  if (!wrap) return;
  wrap.hidden = (_media.length >= _total);
}

// ─── Sidebar rendering ───

function _renderSidebar() {
  const el = _overlayEl;
  if (!el) return;
  const sidebar = el.querySelector('[data-mb-sidebar="1"]');
  if (!sidebar) return;
  sidebar.innerHTML = '';

  // ── Filters section ──
  const filters = document.createElement('div');
  filters.className = 'mbFilters';

  // Search
  const searchLabel = document.createElement('label');
  searchLabel.className = 'mbFilterLabel';
  searchLabel.textContent = 'Search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'mbSearchInput';
  searchInput.placeholder = 'Filter by description…';
  searchInput.value = _filterQ;
  let _debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      _filterQ = searchInput.value.trim();
      _selectedId = null;
      _selectedDetail = null;
      _loadPage(0);
      _renderMetadata();
    }, 300);
  });
  filters.appendChild(searchLabel);
  filters.appendChild(searchInput);

  // Sort
  const sortLabel = document.createElement('label');
  sortLabel.className = 'mbFilterLabel';
  sortLabel.textContent = 'Sort';
  const sortSelect = document.createElement('select');
  sortSelect.className = 'mbSortSelect';
  const sortOptions = [
    ['gramps_id_asc', 'Gramps ID (A→Z)'],
    ['description_asc', 'Description (A→Z)'],
    ['description_desc', 'Description (Z→A)'],
  ];
  for (const [val, label] of sortOptions) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === _filterSort) opt.selected = true;
    sortSelect.appendChild(opt);
  }
  sortSelect.addEventListener('change', () => {
    _filterSort = sortSelect.value;
    _selectedId = null;
    _selectedDetail = null;
    _loadPage(0);
    _renderMetadata();
  });
  filters.appendChild(sortLabel);
  filters.appendChild(sortSelect);

  // Count display
  const countEl = document.createElement('div');
  countEl.className = 'mbCount muted';
  countEl.setAttribute('data-mb-count', '1');
  filters.appendChild(countEl);

  sidebar.appendChild(filters);

  // ── Separator ──
  const sep = document.createElement('hr');
  sep.className = 'mbSep';
  sidebar.appendChild(sep);

  // ── Metadata section ──
  const metaWrap = document.createElement('div');
  metaWrap.className = 'mbMetaWrap';
  metaWrap.setAttribute('data-mb-meta', '1');
  sidebar.appendChild(metaWrap);

  _renderMetadata();
}

function _renderMetadata() {
  const el = _overlayEl;
  if (!el) return;
  const metaWrap = el.querySelector('[data-mb-meta="1"]');
  if (!metaWrap) return;

  // Update count
  const countEl = el.querySelector('[data-mb-count="1"]');
  if (countEl) countEl.textContent = `${_total} media item${_total !== 1 ? 's' : ''}`;

  if (!_selectedDetail) {
    metaWrap.innerHTML = '<div class="mbMetaEmpty muted">Select an image to see details.</div>';
    return;
  }

  const d = _selectedDetail;
  metaWrap.innerHTML = '';

  // Preview image
  const preview = document.createElement('div');
  preview.className = 'mbMetaPreview';
  const img = document.createElement('img');
  img.src = api.withPrivacy(d.original_url || d.thumb_url);
  img.alt = d.description || '';
  img.loading = 'lazy';
  img.addEventListener('click', () => {
    // Open in lightbox from the full media list, starting at this image's index
    const idx = _media.findIndex(m => m.id === d.id);
    const mediaForOverlay = _media.map(m => ({
      ...m,
      original_url: m.original_url || `/media/file/original/${m.id}.jpg`,
      thumb_url: m.thumb_url || `/media/file/thumb/${m.id}.jpg`,
    }));
    showMediaOverlay({ media: mediaForOverlay, startIndex: Math.max(0, idx) });
  });
  preview.appendChild(img);
  metaWrap.appendChild(preview);

  // Description
  if (d.description) {
    const desc = document.createElement('div');
    desc.className = 'mbMetaTitle';
    desc.textContent = d.description;
    metaWrap.appendChild(desc);
  }

  // Detail rows
  const details = document.createElement('div');
  details.className = 'mbMetaDetails';
  const rows = [];
  if (d.gramps_id) rows.push(['ID', d.gramps_id]);
  if (d.mime) rows.push(['Type', d.mime]);
  if (d.width && d.height) rows.push(['Size', `${d.width} × ${d.height} px`]);
  if (d.file_size) rows.push(['File', _formatBytes(d.file_size)]);
  if (d.checksum) rows.push(['Checksum', d.checksum.slice(0, 12) + '…']);

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'mbMetaRow';
    row.innerHTML = `<span class="mbMetaLabel">${_htmlEsc(label)}</span><span class="mbMetaValue">${_htmlEsc(value)}</span>`;
    details.appendChild(row);
  }
  metaWrap.appendChild(details);

  // References
  const refs = d.references;
  if (refs) {
    const persons = Array.isArray(refs.persons) ? refs.persons : [];
    const events = Array.isArray(refs.events) ? refs.events : [];
    const places = Array.isArray(refs.places) ? refs.places : [];

    if (persons.length || events.length || places.length) {
      const refsSection = document.createElement('div');
      refsSection.className = 'mbMetaRefs';
      const refsTitle = document.createElement('div');
      refsTitle.className = 'mbMetaRefsTitle';
      refsTitle.textContent = 'Referenced by';
      refsSection.appendChild(refsTitle);

      for (const p of persons) {
        const link = document.createElement('a');
        link.className = 'mbRefLink';
        link.href = '#';
        link.textContent = `${p.display_name || p.gramps_id || p.id}`;
        link.title = p.gramps_id ? `Person ${p.gramps_id}` : '';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          closeMediaBrowser();
          if (_loadNeighborhood && p.id) {
            _loadNeighborhood(p.id);
          }
        });
        refsSection.appendChild(link);
      }

      for (const ev of events) {
        const span = document.createElement('span');
        span.className = 'mbRefText muted';
        span.textContent = `Event: ${ev.gramps_id || ev.id}`;
        refsSection.appendChild(span);
      }

      for (const pl of places) {
        const span = document.createElement('span');
        span.className = 'mbRefText muted';
        span.textContent = `Place: ${pl.name || pl.gramps_id || pl.id}`;
        refsSection.appendChild(span);
      }

      metaWrap.appendChild(refsSection);
    }
  }
}

// ─── Grid rendering ───

function _renderGrid() {
  const el = _overlayEl;
  if (!el) return;
  const grid = el.querySelector('[data-mb-grid="1"]');
  if (!grid) return;
  grid.innerHTML = '';

  if (!_media.length) {
    grid.innerHTML = '<div class="mbGridEmpty muted">No media found.</div>';
    return;
  }

  for (const m of _media) {
    const cell = document.createElement('div');
    cell.className = 'mbCell';
    if (m.id === _selectedId) cell.classList.add('selected');

    const img = document.createElement('img');
    const thumbUrl = m.thumb_url || `/media/file/thumb/${m.id}.jpg`;
    img.src = api.withPrivacy(thumbUrl);
    img.alt = m.description || m.gramps_id || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    cell.appendChild(img);

    const caption = document.createElement('div');
    caption.className = 'mbCellCaption';
    caption.textContent = m.description || m.gramps_id || '';
    cell.appendChild(caption);

    cell.addEventListener('click', () => _selectMedia(m.id));

    grid.appendChild(cell);
  }
}

async function _selectMedia(mediaId) {
  _selectedId = mediaId;

  // Highlight in grid
  const el = _overlayEl;
  if (el) {
    for (const c of el.querySelectorAll('.mbCell')) {
      c.classList.remove('selected');
    }
    const cells = el.querySelectorAll('.mbCell');
    const idx = _media.findIndex(m => m.id === mediaId);
    if (idx >= 0 && cells[idx]) cells[idx].classList.add('selected');
  }

  // Fetch detail
  try {
    _selectedDetail = await api.fetchMediaDetail(mediaId);
    _renderMetadata();
  } catch (e) {
    console.error('Media browser: detail fetch failed', e);
    _selectedDetail = _media.find(m => m.id === mediaId) || null;
    _renderMetadata();
  }
}

// ─── Helpers ───

function _formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function _htmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
