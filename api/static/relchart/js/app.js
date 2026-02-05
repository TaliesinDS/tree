import * as api from './api.js';
import { els, state } from './state.js';
import { copyToClipboard } from './util/clipboard.js';
import {
  formatEventTitle,
  formatEventPlaceForSidebar,
  formatEventSubLine,
  formatEventSubLineNoPlace,
} from './util/event_format.js';
import {
  initPeopleFeature,
  selection,
  ensurePeopleIndexLoaded,
  ensurePeopleLoaded,
  _applyPeopleSelectionToDom,
  _renderPeopleList,
} from './features/people.js';
import {
  initFamiliesFeature,
  ensureFamiliesLoaded,
  setSelectedFamilyKey,
  _applyFamiliesSelectionToDom,
} from './features/families.js';
import {
  initMapFeature,
  resolvePlaceForMap,
  centerMapOnPlace,
  onEnterMapTab,
  onLeaveMapTab,
} from './features/map.js';
import {
  initPlacesFeature,
  ensurePlacesLoaded,
  selectPlaceGlobal,
  closePlaceEventsPanel,
  _applyPlacesSelectionToDom,
} from './features/places.js';
import {
  initDetailPanelFeature,
  renderPersonDetailPanelSkeleton,
  loadPersonDetailsIntoPanel,
  ensureDetailPeekTab,
  setDetailPeekVisible,
  positionDetailPeekTab,
  loadDetailPanelPos,
  loadDetailPanelSize,
  applyDetailPanelPos,
  applyDetailPanelSize,
} from './features/detailPanel.js';
import {
  initEventsFeature,
  ensureEventsLoaded,
} from './features/events.js';
import { eventSelection } from './features/eventSelection.js';
import { initEventDetailPanelFeature } from './features/eventDetailPanel.js';
import {
  initTabsFeature,
  getSidebarActiveTab,
  setSidebarActiveTab,
  setTopbarControlsMode,
} from './features/tabs.js';
import { initKeybindsFeature } from './features/keybinds.js';
import { initGraphFeature, rerenderGraph } from './features/graph.js';
import { initOptionsFeature } from './features/options.js';

function _selectParentFamilyForPersonInSidebar(personApiId) {
  const pid = String(personApiId || '').trim();
  if (!pid) return;
  if (getSidebarActiveTab() !== 'families') return;

  const edges = Array.isArray(state.payload?.edges) ? state.payload.edges : [];
  let familyId = null;
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    if (String(e?.from || '') !== pid) continue;
    const fid = String(e?.to || '').trim();
    if (!fid) continue;
    familyId = fid;
    break;
  }
  // Fallback: if they are not a visible parent/spouse in any family, select their
  // parent family (i.e., the family where they appear as a child).
  if (!familyId) {
    for (const e of edges) {
      if (e?.type !== 'child') continue;
      if (String(e?.to || '') !== pid) continue;
      const fid = String(e?.from || '').trim();
      if (!fid) continue;
      familyId = fid;
      break;
    }
  }
  if (!familyId) return;

  const famNode = state.nodeById?.get?.(String(familyId)) || null;
  const key = String(famNode?.gramps_id || familyId || '').trim();
  if (!key) return;

  try { ensureFamiliesLoaded(); } catch (_) {}
  try { setSelectedFamilyKey(key, { source: 'person-parent', scrollFamilies: true }); } catch (_) {}
}

// Keep the floating detail panel in sync with selection.
selection.subscribe((next) => {
  // Selection can be set from the graph (apiId) or from the People list (grampsId).
  // Backend endpoints accept either, so use whichever is available.
  // Prefer grampsId when present: it's what the user typed/selected.
  const ref = String(next?.grampsId || next?.apiId || next?.key || '').trim();
  if (!ref) return;

  // If the panel is closed, keep the peek tab visible and updated.
  if (!state.detailPanel.open) {
    try { setDetailPeekVisible(true); } catch (_) {}
  }

  // Update detail data (and peek tab) without forcing the panel open.
  // Note: endpoints accept either Gramps ID or API id.
  try { loadPersonDetailsIntoPanel(ref, { openPanel: state.detailPanel.open }); } catch (_) {}

  // If the user is viewing Families, prefer selecting a relevant family.
  try {
    const tab = getSidebarActiveTab();
    const apiId = String(next?.apiId || '').trim();
    if (tab === 'families' && apiId) {
      _selectParentFamilyForPersonInSidebar(apiId);
    }
  } catch (_) {}
});

function _resolveSelectedPersonIdFromPayload(payload, sel) {
  const s = sel?.get?.() || {};
  const wantApi = String(s.apiId || '').trim();
  const wantGramps = String(s.grampsId || '').trim();
  const wantKey = String(s.key || '').trim();

  if (!payload?.nodes) return null;

  // Prefer explicit api id.
  if (wantApi) {
    const hit = payload.nodes.find(n => String(n?.id || '').trim() === wantApi);
    if (hit) return String(hit.id);
  }

  // Then gramps id / key.
  const want = wantGramps || wantKey;
  if (want) {
    const hit = payload.nodes.find(n => n?.type === 'person' && String(n?.gramps_id || '').trim() === want);
    if (hit) return String(hit.id);
  }

  return null;
}

function _resolveRelationsRootPersonId() {
  const direct = String(state.selectedPersonId || '').trim();
  if (direct) return direct;
  return _resolveSelectedPersonIdFromPayload(state.payload, selection);
}

function setStatus(msg, isError = false) {
  const m = String(msg ?? '');
  els.status.textContent = m;
  els.status.title = m;
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';

  // Remember the last non-Map status so leaving the Map tab doesn't keep a
  // stale "Map: ..." message in the topbar.
  try {
    if (!/^map\s*:/i.test(m)) {
      state.status.lastNonMapMsg = m;
      state.status.lastNonMapIsError = !!isError;
    }
  } catch (_) {}
}


async function rerender() {
  return rerenderGraph();
}

async function loadNeighborhood() {
  const personId = String(els.personId.value || '').trim();
  const depth = Number(els.depth.value || '2');
  const maxNodes = Number(els.maxNodes.value || '1000');

  if (!personId) {
    setStatus('Missing Person ID', true);
    return;
  }

  setStatus('Loading…');
  try {
    state.payload = await api.neighborhood({ personId, depth, maxNodes });

    // When the user typed a Person ID and clicked Load, treat that as the new
    // global selection so the People list + detail panel stay in sync.
    const requested = String(personId || '').trim();
    const nodes = Array.isArray(state.payload?.nodes) ? state.payload.nodes : [];
    const looksLikeGrampsId = /^I\d+$/i.test(requested);
    const directHit = nodes.find(n => {
      if (n?.type !== 'person') return false;
      const apiId = String(n?.id || '').trim();
      const gid = String(n?.gramps_id || '').trim();
      return (gid && gid === requested) || (apiId && apiId === requested);
    }) || null;

    const resolvedApiId = directHit?.id ? String(directHit.id) : null;
    let resolvedGrampsId = String(directHit?.gramps_id || '').trim() || null;

    // For a manual Load, prefer the requested person (so we don't keep a stale
    // prior selection like I0001 when the user loads I0022).
    state.selectedPersonId = resolvedApiId || _resolveSelectedPersonIdFromPayload(state.payload, selection);
    if (state.selectedPersonId && !resolvedGrampsId) {
      const byApi = nodes.find(n => n?.type === 'person' && String(n?.id || '').trim() === String(state.selectedPersonId)) || null;
      resolvedGrampsId = String(byApi?.gramps_id || '').trim() || null;
    }

    // Finally, make the selection store reflect what we just loaded.
    // Prefer gramps id for keying the People list; always include api id when known.
    const activeTab = getSidebarActiveTab();
    selection.selectPerson(
      {
        apiId: state.selectedPersonId || null,
        grampsId: resolvedGrampsId || (looksLikeGrampsId ? requested : null),
      },
      { source: 'load', scrollPeople: activeTab === 'people', updateInput: true },
    );

    setStatus(`Loaded ${state.payload.nodes?.length || 0} nodes, ${state.payload.edges?.length || 0} edges.`);
    await rerender();
  } catch (e) {
    setStatus(`Failed: ${e?.message || e}`, true);
  }
}

els.loadBtn.addEventListener('click', loadNeighborhood);

els.resetBtn.addEventListener('click', () => {
  state.payload = null;
  state.selectedPersonId = null;
  if (els.graphView) els.graphView.innerHTML = '';
  else if (els.chart) els.chart.innerHTML = '';
  setStatus('Ready.');
});

els.fitBtn.addEventListener('click', () => {
  state.panZoom?.reset?.();
});

// Initial
setStatus('Ready.');
initOptionsFeature({ renderPeopleList: _renderPeopleList });
initGraphFeature({
  selection,
  getSidebarActiveTab,
  setSidebarActiveTab,
  ensureFamiliesLoaded,
  setSelectedFamilyKey,
  loadPersonDetailsIntoPanel,
  setStatus,
  copyToClipboard,
  selectParentFamilyForPersonInSidebar: _selectParentFamilyForPersonInSidebar,
});
initMapFeature({
  setStatus,
  ensurePlacesLoaded,
  selectPlaceGlobal,
  applyPlacesSelectionToDom: _applyPlacesSelectionToDom,
  resolveRelationsRootPersonId: _resolveRelationsRootPersonId,
});
initDetailPanelFeature({
  selection,
  loadNeighborhood,
  ensurePeopleIndexLoaded,
  getSidebarActiveTab,
  selectPlaceGlobal,
  resolveRelationsRootPersonId: _resolveRelationsRootPersonId,
  formatEventPlaceForSidebar,
});
try { setTopbarControlsMode(getSidebarActiveTab() === 'map' ? 'map' : 'graph'); } catch (_) {}

initTabsFeature({
  setStatus,
  onEnterMapTab,
  onLeaveMapTab,
  closePlaceEventsPanel,
  ensurePeopleLoaded,
  applyPeopleSelectionToDom: _applyPeopleSelectionToDom,
  ensureFamiliesLoaded,
  applyFamiliesSelectionToDom: _applyFamiliesSelectionToDom,
  ensureEventsLoaded,
  ensurePlacesLoaded,
  resolvePlaceForMap,
  centerMapOnPlace,
  applyPlacesSelectionToDom: _applyPlacesSelectionToDom,
  selection,
  selectParentFamilyForPersonInSidebar: _selectParentFamilyForPersonInSidebar,
});
initKeybindsFeature();

loadDetailPanelPos();
loadDetailPanelSize();
renderPersonDetailPanelSkeleton();
try { ensureDetailPeekTab(); } catch (_) {}
try { positionDetailPeekTab(); } catch (_) {}
try { applyDetailPanelSize(); } catch (_) {}
try { applyDetailPanelPos(); } catch (_) {}

try {
  window.addEventListener('resize', () => {
    applyDetailPanelSize();
    applyDetailPanelPos();
    positionDetailPeekTab();
  });
} catch (_) {}

// Auto-load the graph on first page load (using the current form values).
try { loadNeighborhood(); } catch (_) {}

initPeopleFeature({ loadNeighborhood });

initFamiliesFeature({ setStatus, loadNeighborhood });

initEventsFeature({
  selection,
  eventSelection,
  loadNeighborhood,
  setStatus,
  copyToClipboard,
  getSidebarActiveTab,
  formatEventTitle,
  formatEventSubLine,
});

initEventDetailPanelFeature({ eventSelection, selection });

initPlacesFeature({
  setStatus,
  loadNeighborhood,
  selection,
  getSidebarActiveTab,
  formatEventTitle,
  formatEventSubLineNoPlace,
});
