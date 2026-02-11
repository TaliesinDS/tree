/**
 * Media browser feature — top-bar "Media" button that opens a browseable
 * media gallery overlay for the current instance.
 */

import * as api from '../api.js';
import { showMediaOverlay } from './mediaOverlay.js';

let _mediaBtn = null;

export function initMediaBrowserFeature() {
  _mediaBtn = document.getElementById('mediaBtn');
  if (!_mediaBtn) return;

  _mediaBtn.addEventListener('click', _openMediaBrowser);
}

async function _openMediaBrowser() {
  try {
    const res = await api.fetchMediaList({ limit: 200, sort: 'gramps_id_asc' });
    const results = Array.isArray(res?.results) ? res.results : [];
    if (!results.length) {
      alert('No media found in this instance.');
      return;
    }

    // Map to the format showMediaOverlay expects
    const media = results.map(m => ({
      ...m,
      original_url: `/media/file/original/${m.id}.jpg`,
      thumb_url: m.thumb_url || `/media/file/thumb/${m.id}.jpg`,
    }));

    showMediaOverlay({ media, startIndex: 0 });
  } catch (e) {
    console.error('Failed to load media list:', e);
  }
}
