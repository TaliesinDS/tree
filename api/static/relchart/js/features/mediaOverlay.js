/**
 * Media overlay / lightbox — shows a full-size image with navigation.
 * 
 * Usage:
 *   import { showMediaOverlay } from './features/mediaOverlay.js';
 *   showMediaOverlay({ media, startIndex, personName });
 */

import * as api from '../api.js';

let _overlayEl = null;
let _currentMedia = [];
let _currentIndex = 0;

function _ensureOverlay() {
  if (_overlayEl && _overlayEl.isConnected) return _overlayEl;

  const existing = document.getElementById('mediaOverlay');
  if (existing) { _overlayEl = existing; return existing; }

  const el = document.createElement('div');
  el.id = 'mediaOverlay';
  el.className = 'mediaOverlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="mediaOverlayBackdrop" data-close="1"></div>
    <div class="mediaOverlayContent">
      <div class="mediaOverlayHeader">
        <span class="mediaOverlayTitle" data-title="1"></span>
        <span class="mediaOverlayCounter" data-counter="1"></span>
        <button class="mediaOverlayCloseBtn" data-close="1" type="button" title="Close">×</button>
      </div>
      <div class="mediaOverlayBody">
        <button class="mediaOverlayNav prev" data-nav="prev" type="button" title="Previous">‹</button>
        <div class="mediaOverlayImageWrap">
          <img class="mediaOverlayImage" data-image="1" alt="" />
        </div>
        <button class="mediaOverlayNav next" data-nav="next" type="button" title="Next">›</button>
      </div>
      <div class="mediaOverlayFooter">
        <span class="mediaOverlayDesc" data-desc="1"></span>
      </div>
    </div>
  `;

  // Event delegation
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close="1"]')) {
      hideMediaOverlay();
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      if (nav.dataset.nav === 'prev') _navigate(-1);
      else if (nav.dataset.nav === 'next') _navigate(1);
      return;
    }
  });

  // Keyboard
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideMediaOverlay(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { _navigate(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { _navigate(1); e.preventDefault(); }
  });

  document.body.appendChild(el);
  _overlayEl = el;
  return el;
}

function _navigate(delta) {
  if (!_currentMedia.length) return;
  _currentIndex = (_currentIndex + delta + _currentMedia.length) % _currentMedia.length;
  _renderCurrent();
}

function _renderCurrent() {
  const el = _ensureOverlay();
  const m = _currentMedia[_currentIndex];
  if (!m) return;

  const img = el.querySelector('[data-image="1"]');
  const title = el.querySelector('[data-title="1"]');
  const desc = el.querySelector('[data-desc="1"]');
  const counter = el.querySelector('[data-counter="1"]');
  const prevBtn = el.querySelector('[data-nav="prev"]');
  const nextBtn = el.querySelector('[data-nav="next"]');

  if (img) {
    img.src = api.withPrivacy(m.original_url || m.thumb_url);
    img.alt = m.description || '';
  }
  if (title) title.textContent = m.description || m.gramps_id || '';
  if (desc) {
    const parts = [];
    if (m.width && m.height) parts.push(`${m.width} × ${m.height}`);
    if (m.mime) parts.push(m.mime);
    desc.textContent = parts.join(' · ');
  }
  if (counter) {
    counter.textContent = _currentMedia.length > 1
      ? `${_currentIndex + 1} / ${_currentMedia.length}`
      : '';
  }
  if (prevBtn) prevBtn.hidden = _currentMedia.length <= 1;
  if (nextBtn) nextBtn.hidden = _currentMedia.length <= 1;
}

/**
 * Show the media overlay.
 * @param {{ media: Array, startIndex?: number, personName?: string }} opts
 */
export function showMediaOverlay({ media = [], startIndex = 0, personName = '' } = {}) {
  if (!media.length) return;
  _currentMedia = media;
  _currentIndex = Math.max(0, Math.min(startIndex, media.length - 1));

  const el = _ensureOverlay();
  el.hidden = false;
  el.tabIndex = 0;

  // Set person name in header if provided
  const titleEl = el.querySelector('[data-title="1"]');
  if (titleEl && personName) {
    titleEl.dataset.personName = personName;
  }

  el.focus();
  _renderCurrent();
}

export function hideMediaOverlay() {
  if (_overlayEl) _overlayEl.hidden = true;
  _currentMedia = [];
  _currentIndex = 0;
}
