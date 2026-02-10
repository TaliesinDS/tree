/**
 * Import feature: lets the user upload a .gpkg/.gramps file through the
 * Options menu, triggers the server-side import pipeline, polls for status,
 * and reloads the viewer when done.
 */

import { getCsrfToken } from '../api.js';
import { els, state } from '../state.js';
import { getSidebarActiveTab, setSidebarActiveTab } from './tabs.js';

/** @type {(() => Promise<void>) | null} */
let _loadNeighborhood = null;

/** @type {((msg: string, isError?: boolean) => void) | null} */
let _setStatus = null;

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1000;
let _pollTimer = null;

function _showOverlay(msg) {
  if (els.importOverlay) {
    els.importOverlay.hidden = false;
  }
  if (els.importOverlayMsg) {
    els.importOverlayMsg.textContent = msg || 'Importing…';
  }
}

function _hideOverlay() {
  if (els.importOverlay) {
    els.importOverlay.hidden = true;
  }
}

function _setImportStatus(msg) {
  if (els.importStatus) {
    els.importStatus.textContent = msg || '';
  }
}

async function _pollImportStatus() {
  try {
    const res = await fetch('/import/status');
    if (!res.ok) return;
    const data = await res.json();

    const status = data.status || 'idle';
    if (status === 'running') {
      _showOverlay('Importing… please wait.');
      _setImportStatus('Import in progress…');
      return; // keep polling
    }

    // Done or failed — stop polling.
    _stopPolling();

    if (status === 'done') {
      _hideOverlay();
      const counts = data.counts || {};
      const personCount = counts.person ?? '?';
      _setImportStatus(`Import complete (${personCount} people). Reloading…`);
      if (_setStatus) _setStatus(`Import complete (${personCount} people). Reloading…`);

      // Invalidate all cached sidebar/tab data so everything re-fetches.
      state.peopleLoaded = false;
      state.people = null;
      state.familiesLoaded = false;
      state.families = null;
      state.eventsLoaded = false;
      state.events = null;
      state.eventsTotal = null;
      state.eventsOffset = 0;
      state.placesLoaded = false;
      state.places = null;
      state.payload = null;

      // Reload the viewer graph after a short delay.
      setTimeout(async () => {
        try {
          if (_loadNeighborhood) await _loadNeighborhood();
        } catch (_) {}

        // Re-activate the current sidebar tab so its list refreshes immediately.
        const activeTab = getSidebarActiveTab();
        if (activeTab) setSidebarActiveTab(activeTab);

        _setImportStatus(`Import complete (${personCount} people).`);
      }, 400);
    } else if (status === 'failed') {
      _hideOverlay();
      const errMsg = data.error || 'Unknown error';
      _setImportStatus(`Import failed: ${errMsg}`);
      if (_setStatus) _setStatus(`Import failed: ${errMsg}`, true);
    } else {
      // idle — nothing to do
      _hideOverlay();
    }
  } catch (err) {
    // Network error during polling — keep trying.
    console.warn('Import status poll error:', err);
  }
}

function _startPolling() {
  _stopPolling();
  _pollTimer = setInterval(_pollImportStatus, POLL_INTERVAL_MS);
}

function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Upload handler
// ---------------------------------------------------------------------------

async function _handleImport() {
  const fileInput = els.importFileInput;
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    _setImportStatus('No file selected.');
    return;
  }

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append('file', file);

  _setImportStatus('Uploading…');
  _showOverlay('Uploading…');

  try {
    const res = await fetch('/import', {
      method: 'POST',
      headers: { 'X-CSRF-Token': getCsrfToken() },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body.detail || `HTTP ${res.status}`;
      _hideOverlay();
      _setImportStatus(`Upload failed: ${detail}`);
      if (_setStatus) _setStatus(`Upload failed: ${detail}`, true);
      return;
    }

    // Upload accepted — start polling for completion.
    _setImportStatus('Import started…');
    _showOverlay('Importing… please wait.');
    if (_setStatus) _setStatus('Import started…');
    _startPolling();
  } catch (err) {
    _hideOverlay();
    _setImportStatus(`Upload error: ${err.message || err}`);
    if (_setStatus) _setStatus(`Upload error: ${err.message || err}`, true);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize the import feature.
 *
 * @param {object} deps
 * @param {() => Promise<void>} deps.loadNeighborhood
 * @param {(msg: string, isError?: boolean) => void} deps.setStatus
 */
export function initImportFeature({ loadNeighborhood, setStatus }) {
  _loadNeighborhood = loadNeighborhood;
  _setStatus = setStatus;

  const fileInput = els.importFileInput;
  const importBtn = els.importBtn;

  if (!fileInput || !importBtn) return;

  // Enable the Import button only when a file is selected.
  fileInput.addEventListener('change', () => {
    const hasFile = fileInput.files && fileInput.files.length > 0;
    importBtn.disabled = !hasFile;
    if (hasFile) {
      _setImportStatus(`Selected: ${fileInput.files[0].name}`);
    } else {
      _setImportStatus('');
    }
  });

  importBtn.addEventListener('click', _handleImport);

  // On page load, check if an import is in progress (e.g. page refreshed).
  _pollImportStatus().then((_status) => {
    // If running, start continuous polling.
    try {
      fetch('/import/status').then(r => r.json()).then(d => {
        if (d.status === 'running') _startPolling();
      }).catch(() => {});
    } catch (_) {}
  });
}
