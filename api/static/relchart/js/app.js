import * as api from './api.js';
import { formatGrampsDateEnglish } from './util/date.js';

import { els, state } from './state.js';
import { _cssEscape } from './util/dom.js';
import { _isInsideDetailsOrPortal, _portalDetailsPanel, _unportalDetailsPanel } from './features/portal.js';
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
  _renderFamiliesList,
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
import {
  initTabsFeature,
  getSidebarActiveTab,
  setSidebarActiveTab,
  setTopbarControlsMode,
} from './features/tabs.js';
import { initKeybindsFeature } from './features/keybinds.js';
import { initGraphFeature, rerenderGraph } from './features/graph.js';

function _formatEventTitle(ev) {
  const t = String(ev?.type || ev?.event_type || 'Event').trim();
  return t || 'Event';
}

function _formatEventPlaceForSidebar(ev) {
  const full = String(ev?.place?.name || '').trim();
  if (!full) return '';

  // Heuristic: if the place ends with "Netherlands"/"Nederland" (or "NL"), hide the country.
  // If it's outside NL, keep the full place string (which should include the country).
  const parts = full.split(',').map(s => String(s).trim()).filter(Boolean);
  if (parts.length < 2) return full;
  const country = String(parts[parts.length - 1] || '').trim();
  if (/^(netherlands|nederland|nl)$/i.test(country)) {
    return parts.slice(0, -1).join(', ');
  }
  return full;
}

function _formatEventSubLine(ev) {
  const dateText = String(ev?.date || ev?.date_text || ev?.event_date || ev?.event_date_text || '').trim();
  const dateUi = dateText ? formatGrampsDateEnglish(dateText) : '';
  const placeName = _formatEventPlaceForSidebar(ev);
  const parts = [];
  if (dateUi) parts.push(dateUi);
  if (placeName) parts.push(placeName);
  return parts.join(' · ');
}

function _formatEventSubLineNoPlace(ev) {
  const dateText = String(ev?.date || ev?.date_text || ev?.event_date || ev?.event_date_text || '').trim();
  const dateUi = dateText ? formatGrampsDateEnglish(dateText) : '';
  return dateUi;
}

const PEOPLE_EXPANDED_KEY = 'tree_relchart_people_expanded_v1';
const PEOPLE_WIDE_PX_KEY = 'tree_relchart_people_wide_px_v1';
const PEOPLE_WIDE_PX_DEFAULT = 440;

function _setPeopleWidePx(px, { persist = true } = {}) {
  let n = Number(px);
  if (!Number.isFinite(n)) return;
  n = Math.round(n);
  n = Math.max(360, Math.min(900, n));
  document.documentElement.style.setProperty('--sidebar-w-wide', `${n}px`);
  if (els.peopleWidth) els.peopleWidth.value = String(n);
  if (persist) {
    try { localStorage.setItem(PEOPLE_WIDE_PX_KEY, String(n)); } catch (_) {}
  }
}

function _setPeopleExpanded(expanded, { persist = true, rerender: shouldRerender = true } = {}) {
  const on = !!expanded;
  state.peopleExpanded = on;
  document.documentElement.dataset.peopleWide = on ? 'true' : 'false';
  if (els.peopleExpandToggle) {
    els.peopleExpandToggle.textContent = on ? 'Compact' : 'Expand';
    els.peopleExpandToggle.title = on ? 'Collapse people list' : 'Expand people list (show years)';
  }
  if (persist) {
    try { localStorage.setItem(PEOPLE_EXPANDED_KEY, on ? '1' : '0'); } catch (_) {}
  }
  if (shouldRerender && state.peopleLoaded && state.people) {
    _renderPeopleList(state.people, els.peopleSearch?.value || '');
  }
}

function _initPeopleExpanded() {
  let on = false;
  try {
    const v = String(localStorage.getItem(PEOPLE_EXPANDED_KEY) || '').trim();
    on = (v === '1' || v.toLowerCase() === 'true');
  } catch (_) {}

  let px = PEOPLE_WIDE_PX_DEFAULT;
  try {
    const raw = String(localStorage.getItem(PEOPLE_WIDE_PX_KEY) || '').trim();
    const n = Number(raw);
    if (Number.isFinite(n)) px = n;
  } catch (_) {}
  _setPeopleWidePx(px, { persist: false });

  if (els.optPeopleWidePx) {
    els.optPeopleWidePx.value = String(px);
    els.optPeopleWidePx.addEventListener('change', () => {
      _setPeopleWidePx(els.optPeopleWidePx.value);
      if (state.peopleExpanded && state.peopleLoaded && state.people) {
        _renderPeopleList(state.people, els.peopleSearch?.value || '');
      }
    });
  }

  // Close the menu when clicking outside.
  if (els.optionsMenu) {
    try {
      els.optionsMenu.addEventListener('toggle', () => {
        if (els.optionsMenu.open) _portalDetailsPanel(els.optionsMenu, '.optionsPanel', { align: 'right' });
        else _unportalDetailsPanel(els.optionsMenu);
      });
    } catch (_) {}

    document.addEventListener('click', (e) => {
      const open = els.optionsMenu.open;
      if (!open) return;
      const t = e.target;
      if (t && _isInsideDetailsOrPortal(els.optionsMenu, t)) return;
      els.optionsMenu.open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        try { els.optionsMenu.open = false; } catch (_) {}
      }
    });
  }

  _setPeopleExpanded(on, { persist: false, rerender: false });
  if (els.peopleExpandToggle) {
    els.peopleExpandToggle.addEventListener('click', () => {
      _setPeopleExpanded(!state.peopleExpanded);
    });
  }
}

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

async function copyToClipboard(text) {
  const s = String(text ?? '');
  if (!s) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_) {}

  // Fallback for environments where Clipboard API isn't available.
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
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
_initPeopleExpanded();
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
  formatEventPlaceForSidebar: _formatEventPlaceForSidebar,
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
  loadNeighborhood,
  setStatus,
  copyToClipboard,
  getSidebarActiveTab,
  formatEventTitle: _formatEventTitle,
  formatEventSubLine: _formatEventSubLine,
});

initPlacesFeature({
  setStatus,
  loadNeighborhood,
  selection,
  getSidebarActiveTab,
  formatEventTitle: _formatEventTitle,
  formatEventSubLineNoPlace: _formatEventSubLineNoPlace,
});
