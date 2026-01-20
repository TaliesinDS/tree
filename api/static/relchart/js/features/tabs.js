import { els, state } from '../state.js';

let _setStatus = null;
let _onEnterMapTab = null;
let _onLeaveMapTab = null;

let _closePlaceEventsPanel = null;

let _ensurePeopleLoaded = null;
let _applyPeopleSelectionToDom = null;

let _ensureFamiliesLoaded = null;
let _applyFamiliesSelectionToDom = null;

let _ensureEventsLoaded = null;

let _ensurePlacesLoaded = null;
let _resolvePlaceForMap = null;
let _centerMapOnPlace = null;
let _applyPlacesSelectionToDom = null;

let _selection = null;
let _selectParentFamilyForPersonInSidebar = null;

export function initTabsFeature({
  setStatus,
  onEnterMapTab,
  onLeaveMapTab,
  closePlaceEventsPanel,
  ensurePeopleLoaded,
  applyPeopleSelectionToDom,
  ensureFamiliesLoaded,
  applyFamiliesSelectionToDom,
  ensureEventsLoaded,
  ensurePlacesLoaded,
  resolvePlaceForMap,
  centerMapOnPlace,
  applyPlacesSelectionToDom,
  selection,
  selectParentFamilyForPersonInSidebar,
} = {}) {
  _setStatus = typeof setStatus === 'function' ? setStatus : null;
  _onEnterMapTab = typeof onEnterMapTab === 'function' ? onEnterMapTab : null;
  _onLeaveMapTab = typeof onLeaveMapTab === 'function' ? onLeaveMapTab : null;

  _closePlaceEventsPanel = typeof closePlaceEventsPanel === 'function' ? closePlaceEventsPanel : null;

  _ensurePeopleLoaded = typeof ensurePeopleLoaded === 'function' ? ensurePeopleLoaded : null;
  _applyPeopleSelectionToDom = typeof applyPeopleSelectionToDom === 'function' ? applyPeopleSelectionToDom : null;

  _ensureFamiliesLoaded = typeof ensureFamiliesLoaded === 'function' ? ensureFamiliesLoaded : null;
  _applyFamiliesSelectionToDom = typeof applyFamiliesSelectionToDom === 'function' ? applyFamiliesSelectionToDom : null;

  _ensureEventsLoaded = typeof ensureEventsLoaded === 'function' ? ensureEventsLoaded : null;

  _ensurePlacesLoaded = typeof ensurePlacesLoaded === 'function' ? ensurePlacesLoaded : null;
  _resolvePlaceForMap = typeof resolvePlaceForMap === 'function' ? resolvePlaceForMap : null;
  _centerMapOnPlace = typeof centerMapOnPlace === 'function' ? centerMapOnPlace : null;
  _applyPlacesSelectionToDom = typeof applyPlacesSelectionToDom === 'function' ? applyPlacesSelectionToDom : null;

  _selection = selection || null;
  _selectParentFamilyForPersonInSidebar = typeof selectParentFamilyForPersonInSidebar === 'function'
    ? selectParentFamilyForPersonInSidebar
    : null;

  // Allow the HTML shell to delegate tab switching to app.js so lazy-loading triggers.
  try {
    window.relchartSetSidebarActiveTab = setSidebarActiveTab;
    window.relchartGetSidebarActiveTab = getSidebarActiveTab;
  } catch (_) {}
}

export function setTopbarControlsMode(kind) {
  const k = String(kind || '').trim().toLowerCase();
  const showMap = (k === 'map');
  if (els.graphControls) els.graphControls.hidden = showMap;
  if (els.mapControls) els.mapControls.hidden = !showMap;
}

export function setMainView(viewName) {
  const v = String(viewName || '').trim().toLowerCase();
  if (!els.chart) return;
  els.chart.dataset.mainView = (v === 'map') ? 'map' : 'graph';
}

export function getSidebarActiveTab() {
  const b = document.querySelector('.tabbtn.active[data-tab]');
  const t = String(b?.dataset?.tab || '').trim();
  return t || null;
}

export function setSidebarActiveTab(tabName) {
  const name = String(tabName || '').trim();
  if (!name) return;

  // Place-events popover is Map-tab-only.
  try {
    if (name !== 'map') _closePlaceEventsPanel?.();
  } catch (_) {}

  const tabButtons = Array.from(document.querySelectorAll('.tabbtn[data-tab]'));
  const tabPanels = Array.from(document.querySelectorAll('.tabpanel[data-panel]'));
  for (const b of tabButtons) {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const p of tabPanels) {
    p.classList.toggle('active', p.dataset.panel === name);
  }

  // Main viewport: show map only for the Map tab; otherwise show graph.
  try {
    setMainView(name === 'map' ? 'map' : 'graph');
    setTopbarControlsMode(name === 'map' ? 'map' : 'graph');

    // Map-only UI and overlays.
    if (name !== 'map') {
      try { _onLeaveMapTab?.(); } catch (_) {}

      try {
        const cur = String(els.status?.textContent || '').trim();
        if (/^map\s*:/i.test(cur)) {
          _setStatus?.(state.status.lastNonMapMsg, state.status.lastNonMapIsError);
        }
      } catch (_) {}
    }

    if (name === 'map') {
      try { _onEnterMapTab?.(); } catch (_) {}
    }
  } catch (_) {}

  // Lazy-load + scroll-to-selection on explicit tab open.
  // (Selection changes elsewhere should not force the sidebar to switch tabs.)
  try {
    if (name === 'people') {
      Promise.resolve(_ensurePeopleLoaded?.()).then(() => {
        try { _applyPeopleSelectionToDom?.({ scroll: true }); } catch (_) {}
      });
    }

    if (name === 'families') {
      Promise.resolve(_ensureFamiliesLoaded?.()).then(() => {
        try {
          if (!state.familiesSelected) {
            const cur = _selection?.get?.() || {};
            if (cur?.apiId) _selectParentFamilyForPersonInSidebar?.(cur.apiId);
          }
        } catch (_) {}
        try { _applyFamiliesSelectionToDom?.({ scroll: true }); } catch (_) {}
      });
    }

    if (name === 'events') {
      Promise.resolve(_ensureEventsLoaded?.()).then(() => {
        // Nothing else to sync yet.
      });
    }

    if (name === 'map') {
      Promise.resolve(_ensurePlacesLoaded?.()).then(() => {
        try {
          const pid = String(state.map.pendingPlaceId || state.placesSelected || '').trim();
          if (pid && state.map.map && els.chart?.dataset?.mainView === 'map') {
            const p = _resolvePlaceForMap?.(pid);
            _centerMapOnPlace?.(p);
          }
        } catch (_) {}

        try { _applyPlacesSelectionToDom?.({ scroll: true }); } catch (_) {}
      });
    }
  } catch (_) {}
}
