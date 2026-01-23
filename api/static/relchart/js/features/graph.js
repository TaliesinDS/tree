import * as api from '../api.js';
import { renderRelationshipChart } from '../chart/render.js';
import { mergeGraphPayload } from '../chart/payload.js';
import { els, state, GRAPH_SETTINGS, _readBool, _writeSetting } from '../state.js';
import { createViewportCuller } from '../chart/culling.js';

let _selection = null;
let _getSidebarActiveTab = null;
let _setSidebarActiveTab = null;

let _ensureFamiliesLoaded = null;
let _setSelectedFamilyKey = null;

let _loadPersonDetailsIntoPanel = null;
let _setStatus = null;
let _copyToClipboard = null;

let _selectParentFamilyForPersonInSidebar = null;

let _cullWired = false;
let _viewportCuller = null;

function _applyCullToggleUi() {
  const el = els.graphCullToggle;
  if (!el) return;
  const on = !!state.graphUi?.cullingEnabled;
  el.textContent = on ? 'Cull: On' : 'Cull: Off';
  try { el.classList.toggle('active', on); } catch (_) {}
}

export function setGraphCullingEnabled(enabled) {
  const on = !!enabled;
  if (!state.graphUi) state.graphUi = { cullingEnabled: false };
  state.graphUi.cullingEnabled = on;
  try { _writeSetting(GRAPH_SETTINGS.cullingEnabled, on ? '1' : '0'); } catch (_) {}
  _applyCullToggleUi();

  try {
    const svg = (els.graphView || els.chart)?.querySelector?.('svg');
    if (!_viewportCuller && svg) {
      _viewportCuller = createViewportCuller(svg, { marginFactor: 0.35, marginPx: 900 });
    }
  } catch (_) {}

  try { _viewportCuller?.setEnabled?.(on); } catch (_) {}
}

export function toggleGraphCulling() {
  setGraphCullingEnabled(!state.graphUi?.cullingEnabled);
}

export function initGraphFeature({
  selection,
  getSidebarActiveTab,
  setSidebarActiveTab,
  ensureFamiliesLoaded,
  setSelectedFamilyKey,
  loadPersonDetailsIntoPanel,
  setStatus,
  copyToClipboard,
  selectParentFamilyForPersonInSidebar,
} = {}) {
  _selection = selection || null;
  _getSidebarActiveTab = typeof getSidebarActiveTab === 'function' ? getSidebarActiveTab : null;
  _setSidebarActiveTab = typeof setSidebarActiveTab === 'function' ? setSidebarActiveTab : null;

  _ensureFamiliesLoaded = typeof ensureFamiliesLoaded === 'function' ? ensureFamiliesLoaded : null;
  _setSelectedFamilyKey = typeof setSelectedFamilyKey === 'function' ? setSelectedFamilyKey : null;

  _loadPersonDetailsIntoPanel = typeof loadPersonDetailsIntoPanel === 'function' ? loadPersonDetailsIntoPanel : null;
  _setStatus = typeof setStatus === 'function' ? setStatus : null;
  _copyToClipboard = typeof copyToClipboard === 'function' ? copyToClipboard : null;

  _selectParentFamilyForPersonInSidebar = typeof selectParentFamilyForPersonInSidebar === 'function'
    ? selectParentFamilyForPersonInSidebar
    : null;

  if (!_cullWired) {
    _cullWired = true;
    try {
      if (!state.graphUi) state.graphUi = { cullingEnabled: false };
      state.graphUi.cullingEnabled = _readBool(GRAPH_SETTINGS.cullingEnabled, false);
    } catch (_) {}
    try { _applyCullToggleUi(); } catch (_) {}
    try {
      els.graphCullToggle?.addEventListener?.('click', () => toggleGraphCulling());
    } catch (_) {}
  }
}

function _setStatusSafe(msg, isError) {
  try {
    if (_setStatus) _setStatus(msg, isError);
  } catch (_) {}
}

function _normalizeGraphvizTitleToId(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  return t.replace(/^node\s+/i, '').trim();
}

function _findPersonNodeElement(svg, personId) {
  const pid = String(personId || '').trim();
  if (!svg || !pid) return null;
  const nodes = svg.querySelectorAll('g.node');
  for (const node of nodes) {
    try {
      if (node.querySelector('ellipse')) continue; // family hub
      const id = _normalizeGraphvizTitleToId(node.querySelector('title')?.textContent?.trim());
      if (id === pid) return node;
    } catch (_) {}
  }
  return null;
}

function _findExpandTabElement(svg, personId, expandKind) {
  const pid = String(personId || '').trim();
  const kind = String(expandKind || '').trim().toLowerCase();
  if (!svg || !pid) return null;

  const attr = (kind === 'children') ? 'data-hidden-children-for' : 'data-hidden-parents-for';
  const tabPolys = Array.from(svg.querySelectorAll(`polygon[${attr}="${pid}"]`));
  if (!tabPolys.length) return null;

  // Prefer the visible tab (it contains a <title>).
  const withTitle = tabPolys.find(el => !!el.querySelector('title'));
  return withTitle || tabPolys[0] || null;
}

function _clearGraphPersonSelection(svg) {
  if (!svg) return;
  try {
    for (const n of svg.querySelectorAll('g.node.personNode.selected')) {
      n.classList.remove('selected');
    }
  } catch (_) {}

  try {
    for (const el of svg.querySelectorAll('[data-selection-border="1"]')) {
      el.remove();
    }
  } catch (_) {}
}

function _applyGraphPersonSelection(svg, personId) {
  if (!svg) return;
  const pid = String(personId || '').trim();
  _clearGraphPersonSelection(svg);
  if (!pid) return;

  const node = _findPersonNodeElement(svg, pid);
  if (!node) return;

  try { node.classList.add('selected'); } catch (_) {}

  const graphLayer = (() => {
    // Graphviz typically wraps everything in a <g id="graph0">.
    const g0 = svg.querySelector('g#graph0');
    if (g0) return g0;
    // Fallback: choose the first top-level <g> if present.
    const g = svg.querySelector('g');
    return g || svg;
  })();

  const raiseFamilyHubsAboveSelection = () => {
    // Ensure hubs render above the selection outline by moving them to the end
    // of the Graphviz layer. Event listeners remain attached.
    try {
      const hubs = Array.from(graphLayer.querySelectorAll('g.node'))
        .filter((n) => !!n.querySelector('ellipse'));
      for (const hub of hubs) {
        try { graphLayer.appendChild(hub); } catch (_) {}
      }
    } catch (_) {}
  };

  // Add a black border overlay around the *whole* person card.
  // The card is composed of multiple overlapping paths, one of which may be
  // vertically translated. Instead of tracing a single path, we outline the
  // union of the card layers in SVG user-space.
  try {
    const isExpandTab = (el) => {
      if (!el) return false;
      try {
        if (el.matches?.('[data-hidden-parents-for],[data-hidden-children-for],[data-hidden-parents-hit],[data-hidden-children-hit]')) return true;
      } catch (_) {}
      return false;
    };

    const layerEls = (() => {
      const rimLayers = Array.from(node.querySelectorAll('[data-rim="1"]'))
        .filter((el) => !isExpandTab(el));
      if (rimLayers.length) return rimLayers;
      // Fallback if rim overlay wasn't built for some reason.
      const base = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
      return base ? [base] : [];
    })();

    if (!layerEls.length) return;

    // Union bounding rect in screen pixels.
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of layerEls) {
      try {
        const r = el.getBoundingClientRect?.();
        if (!r) continue;
        if (!Number.isFinite(r.left) || !Number.isFinite(r.top) || !Number.isFinite(r.right) || !Number.isFinite(r.bottom)) continue;
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      } catch (_) {}
    }
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return;
    if (right <= left || bottom <= top) return;

    // Convert screen rect -> the coordinate space of the layer we will append into.
    // g#graph0 is typically translated; using svg.getScreenCTM() would yield SVG-root
    // user-space, which becomes wrong once the border lives under g#graph0.
    const m = graphLayer.getScreenCTM?.() || svg.getScreenCTM?.();
    if (!m || typeof m.inverse !== 'function') return;
    const inv = m.inverse();

    const p0 = new DOMPoint(left, top).matrixTransform(inv);
    const p1 = new DOMPoint(right, bottom).matrixTransform(inv);

    // Outline thickness + padding.
    // Stroke is centered on the path. To avoid a visible inner gap, keep `pad` < strokeW/2
    // so the inner half of the stroke overlaps the card slightly.
    const strokeW = 4;
    const pad = 1.5;
    const x = Math.min(p0.x, p1.x) - pad;
    const y = Math.min(p0.y, p1.y) - pad;
    const w = Math.abs(p1.x - p0.x) + (pad * 2);
    const h = Math.abs(p1.y - p0.y) + (pad * 2);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

    // Corner radius: match the card's rounded corners.
    const rr = Math.max(0, Math.min(20, Math.min(w, h) / 3.2));
    const roundedRectPath = (x0, y0, w0, h0, r) => {
      const xA = x0;
      const yA = y0;
      const xB = x0 + w0;
      const yB = y0 + h0;
      const rad = Math.max(0, Math.min(r, Math.min(w0, h0) / 2));
      return [
        `M ${xA + rad} ${yA}`,
        `H ${xB - rad}`,
        `A ${rad} ${rad} 0 0 1 ${xB} ${yA + rad}`,
        `V ${yB - rad}`,
        `A ${rad} ${rad} 0 0 1 ${xB - rad} ${yB}`,
        `H ${xA + rad}`,
        `A ${rad} ${rad} 0 0 1 ${xA} ${yB - rad}`,
        `V ${yA + rad}`,
        `A ${rad} ${rad} 0 0 1 ${xA + rad} ${yA}`,
        'Z',
      ].join(' ');
    };

    const ns = 'http://www.w3.org/2000/svg';
    const border = document.createElementNS(ns, 'path');
    border.setAttribute('d', roundedRectPath(x, y, w, h, rr));
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', '#000');
    border.setAttribute('stroke-width', String(strokeW));
    border.setAttribute('opacity', '1');
    border.setAttribute('data-selection-border', '1');
    border.style.pointerEvents = 'none';

    graphLayer.appendChild(border);
    raiseFamilyHubsAboveSelection();
  } catch (_) {}
}

function _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind } = {}) {
  const svg = els.chart?.querySelector('svg');
  if (!svg) return null;

  const vb = (state.panZoom?.getViewBox?.() || null);
  const viewBox = vb && Number.isFinite(vb.w) && Number.isFinite(vb.h)
    ? vb
    : (() => {
        const b = svg.viewBox?.baseVal;
        if (!b) return null;
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      })();
  if (!viewBox || !Number.isFinite(viewBox.w) || !Number.isFinite(viewBox.h) || viewBox.w <= 0 || viewBox.h <= 0) return null;

  const containerRect = els.chart.getBoundingClientRect();
  if (!containerRect || !Number.isFinite(containerRect.width) || !Number.isFinite(containerRect.height) || containerRect.width <= 0 || containerRect.height <= 0) return null;

  // Preferred: anchor to the actual click location (expand arrow).
  let desiredClient = null;
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    const rx = cx - containerRect.left;
    const ry = cy - containerRect.top;
    if (Number.isFinite(rx) && Number.isFinite(ry)) desiredClient = { x: rx, y: ry };
  }

  // If this came from an expand click, also capture the offset within the tab
  // so we can keep the exact clicked point stable (not just the tab center).
  let anchorOffset = { x: 0, y: 0 };
  const kind = String(expandKind || '').trim().toLowerCase();
  if (desiredClient && (kind === 'parents' || kind === 'children')) {
    const tabEl = _findExpandTabElement(svg, personId, kind);
    if (tabEl && typeof tabEl.getBoundingClientRect === 'function') {
      try {
        const tr = tabEl.getBoundingClientRect();
        const tc = {
          x: (tr.left + tr.width / 2) - containerRect.left,
          y: (tr.top + tr.height / 2) - containerRect.top,
        };
        if (Number.isFinite(tc.x) && Number.isFinite(tc.y)) {
          anchorOffset = {
            x: desiredClient.x - tc.x,
            y: desiredClient.y - tc.y,
          };
        }
      } catch (_) {}
    }
  }

  // Fallback: anchor to the card center.
  if (!desiredClient) {
    const nodeEl = _findPersonNodeElement(svg, personId);
    if (!nodeEl || typeof nodeEl.getBoundingClientRect !== 'function') return null;
    const r = nodeEl.getBoundingClientRect();
    desiredClient = {
      x: (r.left + r.width / 2) - containerRect.left,
      y: (r.top + r.height / 2) - containerRect.top,
    };
    if (!Number.isFinite(desiredClient.x) || !Number.isFinite(desiredClient.y)) return null;
  }

  return {
    personId: String(personId),
    expandKind: kind || null,
    viewBox,
    desiredClient,
    anchorOffset,
  };
}

function _restoreViewAnchorForPerson(anchor) {
  if (!anchor) return;
  const svg = els.chart?.querySelector('svg');
  if (!svg) return;

  const viewBox = anchor.viewBox;
  const desiredClient = anchor.desiredClient;
  const anchorOffset = anchor.anchorOffset || { x: 0, y: 0 };
  const containerRect = els.chart.getBoundingClientRect();
  if (!containerRect || !Number.isFinite(containerRect.width) || !Number.isFinite(containerRect.height) || containerRect.width <= 0 || containerRect.height <= 0) return;

  const clientDeltaToSvgDelta = (dxPx, dyPx) => {
    const dx = Number(dxPx);
    const dy = Number(dyPx);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    try {
      const m = svg.getScreenCTM?.();
      if (!m || typeof m.inverse !== 'function') return null;
      const inv = m.inverse();
      // Transform as a vector by subtracting two transformed points.
      const p0 = new DOMPoint(0, 0).matrixTransform(inv);
      const p1 = new DOMPoint(dx, dy).matrixTransform(inv);
      const dxSvg = p1.x - p0.x;
      const dySvg = p1.y - p0.y;
      if (!Number.isFinite(dxSvg) || !Number.isFinite(dySvg)) return null;
      return { dxSvg, dySvg };
    } catch (_) {
      return null;
    }
  };

  const measureCurrentCenter = () => {
    const kind = String(anchor.expandKind || '').trim().toLowerCase();
    const tabEl = (kind === 'parents' || kind === 'children')
      ? _findExpandTabElement(svg, anchor.personId, kind)
      : null;
    const el = tabEl || _findPersonNodeElement(svg, anchor.personId);
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2) - containerRect.left,
      y: (r.top + r.height / 2) - containerRect.top,
    };
  };

  const desiredCenter = {
    x: desiredClient.x - Number(anchorOffset.x || 0),
    y: desiredClient.y - Number(anchorOffset.y || 0),
  };

  const computeAndApplyOnce = () => {
    // Start from the pre-expand viewBox (preserve zoom level exactly).
    state.panZoom?.setViewBox?.(viewBox);

    const current = measureCurrentCenter();
    if (!current) return;
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) return;

    // How far did the card drift on-screen? Convert that pixel drift back to
    // SVG units and pan by the same amount so the card returns to its old
    // screen position.
    const dxPx = current.x - desiredCenter.x;
    const dyPx = current.y - desiredCenter.y;
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;

    const vbNow = state.panZoom?.getViewBox?.() || viewBox;
    if (!vbNow || !Number.isFinite(vbNow.w) || !Number.isFinite(vbNow.h) || vbNow.w <= 0 || vbNow.h <= 0) return;

    const del = clientDeltaToSvgDelta(dxPx, dyPx);
    // Fallback if CTM isn't available.
    const dxSvg = del ? del.dxSvg : (dxPx * (vbNow.w / containerRect.width));
    const dySvg = del ? del.dySvg : (dyPx * (vbNow.h / containerRect.height));

    const corrected = {
      x: vbNow.x + dxSvg,
      y: vbNow.y + dySvg,
      w: vbNow.w,
      h: vbNow.h,
    };

    state.panZoom?.setViewBox?.(corrected);
  };

  // Two frames: first after SVG insertion, second after fonts/layout settle.
  try {
    requestAnimationFrame(() => {
      computeAndApplyOnce();
      requestAnimationFrame(() => {
        // One more correction pass if needed (crowded relayout can shift late).
        computeAndApplyOnce();
        requestAnimationFrame(computeAndApplyOnce);
      });
    });
  } catch (_) {
    computeAndApplyOnce();
  }
}

function _rebuildNodeIndex(payload) {
  const m = new Map();
  for (const n of (payload?.nodes || [])) {
    if (!n?.id) continue;
    m.set(String(n.id), n);
  }
  state.nodeById = m;
}

function _formatIdStatus({ kind, apiId, grampsId }) {
  const a = String(apiId || '').trim();
  const g = String(grampsId || '').trim();
  const k = String(kind || 'node');
  if (a && g) return `${k}: api=${a} · gramps=${g}`;
  if (a) return `${k}: api=${a}`;
  if (g) return `${k}: gramps=${g}`;
  return `${k}: (no id)`;
}

export async function rerenderGraph() {
  if (!state.payload) return;
  _rebuildNodeIndex(state.payload);

  const { panZoom } = await renderRelationshipChart({
    container: els.graphView || els.chart,
    payload: state.payload,
    onSelectPerson: (pid) => {
      state.selectedPersonId = pid;
      try {
        const svg = (els.graphView || els.chart)?.querySelector('svg');
        _applyGraphPersonSelection(svg, pid);
      } catch (_) {}

      // Update detail data (and peek tab) without forcing the panel open.
      try { _loadPersonDetailsIntoPanel?.(pid, { openPanel: state.detailPanel.open }); } catch (_) {}

      const node = state.nodeById.get(String(pid)) || null;
      // Graph click behaves like a global selection, but should not force sidebar tab switches.
      const activeTab = _getSidebarActiveTab ? _getSidebarActiveTab() : null;
      _selection?.selectPerson?.(
        { apiId: pid, grampsId: node?.gramps_id },
        { source: 'graph', scrollPeople: activeTab === 'people', updateInput: true },
      );

      // If the user is currently viewing Families, prefer selecting a family where this person is a parent.
      try { _selectParentFamilyForPersonInSidebar?.(pid); } catch (_) {}

      const msg = _formatIdStatus({
        kind: 'Person',
        apiId: pid,
        grampsId: node?.gramps_id,
      });
      _setStatusSafe(msg);

      const copyText = node?.gramps_id
        ? `api_id=${String(pid)}\ngramps_id=${String(node.gramps_id)}`
        : `api_id=${String(pid)}`;
      _copyToClipboard?.(copyText).then((ok) => {
        if (ok) _setStatusSafe(msg + ' (copied)');
      });
    },
    onSelectFamily: (fid) => {
      const node = state.nodeById.get(String(fid)) || null;

      // Behave like a global selection: switch to Families and scroll-highlight.
      try { _setSidebarActiveTab?.('families'); } catch (_) {}
      try { _ensureFamiliesLoaded?.(); } catch (_) {}
      try { _setSelectedFamilyKey?.(String(node?.gramps_id || fid || '').trim(), { source: 'graph', scrollFamilies: true }); } catch (_) {}

      const msg = _formatIdStatus({
        kind: 'Family',
        apiId: fid,
        grampsId: node?.gramps_id,
      });
      _setStatusSafe(msg);

      const copyText = node?.gramps_id
        ? `api_id=${String(fid)}\ngramps_id=${String(node.gramps_id)}`
        : `api_id=${String(fid)}`;
      _copyToClipboard?.(copyText).then((ok) => {
        if (ok) _setStatusSafe(msg + ' (copied)');
      });
    },
    onExpandParents: async ({ personId, familyId, expandKind, clientX, clientY }) => {
      if (!familyId) return;
      const anchor = _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind });
      _setStatusSafe(`Expanding parents: ${familyId} …`);
      const delta = await api.familyParents({ familyId, childId: personId });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerenderGraph();
      _restoreViewAnchorForPerson(anchor);
    },
    onExpandChildren: async ({ personId, familyId, expandKind, clientX, clientY }) => {
      if (!familyId) return;
      const anchor = _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind });
      _setStatusSafe(`Expanding children: ${familyId} …`);
      const delta = await api.familyChildren({ familyId, includeSpouses: true });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerenderGraph();
      _restoreViewAnchorForPerson(anchor);
    },
    onFit: (fn) => {
      els.fitBtn.onclick = fn;
    },
    onViewBoxChange: (_vb) => {
      try { _viewportCuller?.scheduleUpdate?.(); } catch (_) {}
    },
  });

  state.panZoom = panZoom;

  // Rebuild the culler every render (new SVG DOM) and apply current setting.
  try { _viewportCuller?.dispose?.(); } catch (_) {}
  _viewportCuller = null;
  try {
    const svg = (els.graphView || els.chart)?.querySelector?.('svg');
    if (svg) {
      _viewportCuller = createViewportCuller(svg, { marginFactor: 0.35, marginPx: 900 });
      _viewportCuller.setEnabled(!!state.graphUi?.cullingEnabled);
    }
  } catch (_) {}

  // Re-apply the latched person selection after every full rerender.
  try {
    const svg = (els.graphView || els.chart)?.querySelector('svg');
    _applyGraphPersonSelection(svg, state.selectedPersonId);
  } catch (_) {}
}
