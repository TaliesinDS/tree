import * as api from './api.js';
import { renderRelationshipChart } from './chart/render.js';
import { mergeGraphPayload } from './chart/payload.js';

const $ = (id) => document.getElementById(id);

const els = {
  personId: $('personId'),
  depth: $('depth'),
  maxNodes: $('maxNodes'),
  loadBtn: $('loadBtn'),
  fitBtn: $('fitBtn'),
  resetBtn: $('resetBtn'),
  status: $('status'),
  chart: $('chart'),
  peopleSearch: $('peopleSearch'),
  peopleStatus: $('peopleStatus'),
  peopleList: $('peopleList'),
  peopleExpandToggle: $('peopleExpandToggle'),
  optPeopleWidePx: $('optPeopleWidePx'),
  optionsMenu: $('optionsMenu'),
};

const state = {
  payload: null,
  selectedPersonId: null,
  panZoom: null,
  people: null,
  peopleLoaded: false,
  peopleSelected: null,
  peopleExpanded: false,
  nodeById: new Map(),
};

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

function _setPeopleExpanded(expanded, { persist = true, rerender = true } = {}) {
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
  if (rerender && state.peopleLoaded && state.people) {
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
    document.addEventListener('click', (e) => {
      const open = els.optionsMenu.open;
      if (!open) return;
      const t = e.target;
      if (t && els.optionsMenu.contains(t)) return;
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

function _setSidebarActiveTab(tabName) {
  const name = String(tabName || '').trim();
  if (!name) return;

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
}

function _cssEscape(s) {
  const v = String(s ?? '');
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
  } catch (_) {}
  return v.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

function _getPeopleOpenGroups() {
  const open = new Set();
  if (!els.peopleList) return open;
  for (const d of els.peopleList.querySelectorAll('details.peopleGroup[open]')) {
    const k = String(d.dataset.groupName || '').trim();
    if (k) {
      open.add(k);
      continue;
    }
    const txt = String(d.querySelector('summary')?.textContent || '').trim();
    const m = txt.match(/^(.*?)(?:\s*\(\d+\)\s*)?$/);
    if (m && m[1]) open.add(m[1].trim());
  }
  return open;
}

function _applyPeopleSelectionToDom({ scroll = true } = {}) {
  if (!els.peopleList) return;
  const key = String(state.peopleSelected || '').trim();

  for (const el of els.peopleList.querySelectorAll('.peopleItem.selected')) {
    el.classList.remove('selected');
  }

  if (!key) return;
  const sel = els.peopleList.querySelector(`.peopleItem[data-person-key="${_cssEscape(key)}"]`);
  if (!sel) return;

  sel.classList.add('selected');
  const group = sel.closest('details.peopleGroup');
  if (group) group.open = true;

  if (!scroll) return;

  const scrollContainer = (els.peopleList.closest('.sidebarPanel') || els.peopleList);
  const centerSelected = () => {
    try {
      const c = scrollContainer;
      const cRect = c.getBoundingClientRect();
      const eRect = sel.getBoundingClientRect();
      if (!cRect || !eRect) return;
      const desiredCenter = cRect.top + (cRect.height / 2);
      const currentCenter = eRect.top + (eRect.height / 2);
      const delta = currentCenter - desiredCenter;
      if (!Number.isFinite(delta)) return;
      // Positive delta means the element is below center: scroll down.
      c.scrollTop += delta;
    } catch (_) {
      // Fallback: at least bring it into view.
      try { sel.scrollIntoView({ block: 'center' }); } catch (_) {
        try { sel.scrollIntoView(); } catch (_) {}
      }
    }
  };

  // Let layout settle (opening <details>, rendering list) before centering.
  try {
    requestAnimationFrame(() => {
      centerSelected();
      requestAnimationFrame(centerSelected);
    });
  } catch (_) {
    centerSelected();
  }
}

function setSelectedPersonKey(key, { source = 'unknown', scrollPeople = true } = {}) {
  const k = String(key || '').trim();
  if (k && state.peopleSelected === k) return;
  state.peopleSelected = k || null;

  // Keep the people list selection in sync without rebuilding the list.
  _applyPeopleSelectionToDom({ scroll: scrollPeople });
}

function createSelectionStore() {
  let current = { apiId: null, grampsId: null, key: null };
  const listeners = new Set();

  const notify = (next, meta) => {
    for (const fn of listeners) {
      try { fn(next, meta); } catch (_) {}
    }
  };

  return {
    get() { return current; },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    selectPerson({ apiId, grampsId } = {}, { source = 'unknown', scrollPeople = true, updateInput = true } = {}) {
      const a = String(apiId || '').trim() || null;
      const g = String(grampsId || '').trim() || null;
      const key = (g || a || '').trim() || null;
      const next = { apiId: a, grampsId: g, key };
      const same = (current.apiId === next.apiId) && (current.grampsId === next.grampsId) && (current.key === next.key);
      current = next;
      if (updateInput && next.grampsId) {
        els.personId.value = next.grampsId;
      }
      if (next.key) setSelectedPersonKey(next.key, { source, scrollPeople });
      if (!same) notify(next, { source });
    },
  };
}

const selection = createSelectionStore();

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
  const els = Array.from(svg.querySelectorAll(`polygon[${attr}="${pid}"]`));
  if (!els.length) return null;

  // Prefer the visible tab (it contains a <title>).
  const withTitle = els.find(el => !!el.querySelector('title'));
  return withTitle || els[0] || null;
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
    // The rim overlay uses a relatively large corner radius; our outline should be a bit larger
    // than the geometric fallback so it visually aligns.
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

    // Put the outline in the Graphviz layer so we can control z-order relative
    // to hubs by reordering nodes within that same layer.
    graphLayer.appendChild(border);
    raiseFamilyHubsAboveSelection();
  } catch (_) {}
}

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

function _getPersonNodeCenterSvg(svg, personId) {
  const node = _findPersonNodeElement(svg, personId);
  if (!node) return null;
  const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
  if (!shape || typeof shape.getBBox !== 'function') return null;
  const bb = shape.getBBox();
  if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) return null;
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
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

function setStatus(msg, isError = false) {
  els.status.textContent = String(msg ?? '');
  els.status.title = String(msg ?? '');
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
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

function rebuildNodeIndex(payload) {
  const m = new Map();
  for (const n of (payload?.nodes || [])) {
    if (!n?.id) continue;
    m.set(String(n.id), n);
  }
  state.nodeById = m;
}

function formatIdStatus({ kind, apiId, grampsId }) {
  const a = String(apiId || '').trim();
  const g = String(grampsId || '').trim();
  const k = String(kind || 'node');
  if (a && g) return `${k}: api=${a} · gramps=${g}`;
  if (a) return `${k}: api=${a}`;
  if (g) return `${k}: gramps=${g}`;
  return `${k}: (no id)`;
}

async function rerender() {
  if (!state.payload) return;
  rebuildNodeIndex(state.payload);
  const { panZoom } = await renderRelationshipChart({
    container: els.chart,
    payload: state.payload,
    onSelectPerson: (pid) => {
      state.selectedPersonId = pid;
      try {
        const svg = els.chart?.querySelector('svg');
        _applyGraphPersonSelection(svg, pid);
      } catch (_) {}
      const node = state.nodeById.get(String(pid)) || null;
      // Graph click should behave like a global selection: switch to People and center-scroll.
      _setSidebarActiveTab('people');
      ensurePeopleLoaded();
      selection.selectPerson({ apiId: pid, grampsId: node?.gramps_id }, { source: 'graph', scrollPeople: true, updateInput: true });
      const msg = formatIdStatus({
        kind: 'Person',
        apiId: pid,
        grampsId: node?.gramps_id,
      });
      setStatus(msg);
      const copyText = node?.gramps_id
        ? `api_id=${String(pid)}\ngramps_id=${String(node.gramps_id)}`
        : `api_id=${String(pid)}`;
      copyToClipboard(copyText).then((ok) => {
        if (ok) setStatus(msg + ' (copied)');
      });
    },
    onSelectFamily: (fid) => {
      const node = state.nodeById.get(String(fid)) || null;
      const msg = formatIdStatus({
        kind: 'Family',
        apiId: fid,
        grampsId: node?.gramps_id,
      });
      setStatus(msg);
      const copyText = node?.gramps_id
        ? `api_id=${String(fid)}\ngramps_id=${String(node.gramps_id)}`
        : `api_id=${String(fid)}`;
      copyToClipboard(copyText).then((ok) => {
        if (ok) setStatus(msg + ' (copied)');
      });
    },
    onExpandParents: async ({ personId, familyId, expandKind, clientX, clientY }) => {
      if (!familyId) return;
      const anchor = _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind });
      setStatus(`Expanding parents: ${familyId} …`);
      const delta = await api.familyParents({ familyId, childId: personId });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerender();
      _restoreViewAnchorForPerson(anchor);
    },
    onExpandChildren: async ({ personId, familyId, expandKind, clientX, clientY }) => {
      if (!familyId) return;
      const anchor = _captureViewAnchorForPerson(personId, { clientX, clientY, expandKind });
      setStatus(`Expanding children: ${familyId} …`);
      const delta = await api.familyChildren({ familyId, includeSpouses: true });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerender();
      _restoreViewAnchorForPerson(anchor);
    },
    onFit: (fn) => {
      els.fitBtn.onclick = fn;
    },
  });

  state.panZoom = panZoom;

  // Re-apply the latched person selection after every full rerender.
  try {
    const svg = els.chart?.querySelector('svg');
    _applyGraphPersonSelection(svg, state.selectedPersonId);
  } catch (_) {}
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
    // Latch selection to the current selection store (people list or prior graph click).
    // Fall back to the requested personId if it matches a person node.
    state.selectedPersonId = _resolveSelectedPersonIdFromPayload(state.payload, selection);
    if (!state.selectedPersonId) {
      const fallback = String(personId || '').trim();
      const hit = (state.payload?.nodes || []).find(n => n?.type === 'person' && String(n?.gramps_id || '').trim() === fallback);
      if (hit?.id) state.selectedPersonId = String(hit.id);
    }
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
  els.chart.innerHTML = '';
  setStatus('Ready.');
});

els.fitBtn.addEventListener('click', () => {
  state.panZoom?.reset?.();
});

// Initial
setStatus('Ready.');
_initPeopleExpanded();

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
}

function _displayPersonLabel(p) {
  const name = String(p?.display_name || '');
  const gid = String(p?.gramps_id || '').trim();
  return gid ? `${name} (${gid})` : name;
}

function _surnameGroupKey(surnameRaw) {
  const raw = String(surnameRaw || '').trim();
  if (!raw || raw === '?') return 'No surname';

  // Normalize apostrophes/punctuation for matching particles, but keep original
  // casing for the returned group label.
  const parts = raw.split(/\s+/g).filter(Boolean);
  if (!parts.length) return raw;

  const particles = new Set([
    // Dutch
    'van', 'v', 'vd', 'vander', 'vander', 'vanden', 'vanden', 'ten', 'ter', 'te', 't', "'t",
    'der', 'den', 'de', 'het',
    // German
    'von', 'zu', 'zum', 'zur',
    // French/Spanish/Portuguese/Italian (common)
    'da', 'das', 'do', 'dos', 'di', 'del', 'della', 'des', 'du', 'la', 'le', 'las', 'los',
    // English/other
    'of', 'the',
  ]);

  let i = 0;
  while (i < parts.length) {
    const tokenOrig = parts[i];
    const tokenNorm = String(tokenOrig)
      .toLowerCase()
      .replace(/[\u2019\u0060]/g, "'")
      .replace(/[.·]/g, '')
      .replace(/[\\/]/g, '')
      .trim();

    // Handle d'Artagnan / l'Overture style names: group by the part after d'/l'.
    if (i === 0 && (tokenNorm.startsWith("d'") || tokenNorm.startsWith("l'"))) {
      const remainder = tokenOrig.slice(2).trim();
      if (remainder) {
        parts[i] = remainder;
      } else {
        i++;
      }
      break;
    }

    if (particles.has(tokenNorm)) {
      i++;
      continue;
    }
    break;
  }

  const remaining = parts.slice(i).filter(Boolean);
  if (!remaining.length) return raw;
  return remaining.join(' ');
}

function _surnameGroupLabel(p) {
  return _surnameGroupKey(p?.surname);
}

function _renderPeopleList(people, query) {
  if (!els.peopleList) return;

  const openGroups = _getPeopleOpenGroups();

  const q = _normKey(query);
  const filtered = q
    ? people.filter((p) => _normKey(_displayPersonLabel(p)).includes(q))
    : people;

  const groups = new Map();
  for (const p of filtered) {
    const k = _surnameGroupLabel(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  // Force No surname group at top.
  const noSurnameIdx = groupNames.indexOf('No surname');
  if (noSurnameIdx > 0) {
    groupNames.splice(noSurnameIdx, 1);
    groupNames.unshift('No surname');
  }

  els.peopleList.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const groupName of groupNames) {
    const peopleInGroup = groups.get(groupName) || [];
    const details = document.createElement('details');
    details.className = 'peopleGroup';
    details.dataset.groupName = groupName;

    const summary = document.createElement('summary');
    summary.textContent = `${groupName} (${peopleInGroup.length})`;
    details.appendChild(summary);

    let groupHasSelection = false;
    for (const p of peopleInGroup) {
      const key = String(p?.gramps_id || p?.id || '').trim();
      if (key && state.peopleSelected && key === state.peopleSelected) {
        groupHasSelection = true;
        break;
      }
    }
    details.open = openGroups.has(groupName) || groupHasSelection;

    for (const p of peopleInGroup) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'peopleItem';

      const key = String(p?.gramps_id || p?.id || '').trim();
      btn.dataset.personKey = key;
      if (state.peopleSelected && state.peopleSelected === key) {
        btn.classList.add('selected');
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = String(p?.display_name || '');

      const metaRow = document.createElement('div');
      metaRow.className = 'metaRow';

      if (state.peopleExpanded) {
        const by = p?.birth_year;
        const dy = p?.death_year;
        const hasBy = (typeof by === 'number') && Number.isFinite(by);
        const hasDy = (typeof dy === 'number') && Number.isFinite(dy);

        // Always render the dates block in expanded mode so IDs align.
        // Use fixed-width sub-spans so:
        // - missing death => "563 -     I1221" (no leading spaces)
        // - missing birth => "    - 1060 I1221"
        const datesBlock = document.createElement('span');
        datesBlock.className = 'datesBlock';

        const birthEl = document.createElement('span');
        birthEl.className = 'dateBirth';
        birthEl.textContent = hasBy ? String(by) : '';

        const dashEl = document.createElement('span');
        dashEl.className = 'dateDash';
        dashEl.textContent = (hasBy || hasDy) ? ' - ' : '';

        const deathEl = document.createElement('span');
        deathEl.className = 'dateDeath';
        deathEl.textContent = hasDy ? String(dy) : '';

        datesBlock.appendChild(birthEl);
        datesBlock.appendChild(dashEl);
        datesBlock.appendChild(deathEl);

        metaRow.appendChild(datesBlock);
      }

      const metaEl = document.createElement('span');
      metaEl.className = 'meta';
      metaEl.textContent = String(p?.gramps_id || p?.id || '');
      metaRow.appendChild(metaEl);

      btn.appendChild(nameEl);
      btn.appendChild(metaRow);

      btn.addEventListener('click', async () => {
        const ref = String(p?.gramps_id || p?.id || '').trim();
        if (!ref) return;
        selection.selectPerson({ grampsId: ref }, { source: 'people-list', scrollPeople: false, updateInput: true });
        await loadNeighborhood();
      });

      details.appendChild(btn);
    }

    frag.appendChild(details);
  }

  frag && els.peopleList.appendChild(frag);

  // Ensure the DOM reflects the current selection and expands the selected group
  // (without collapsing any other groups the user opened).
  _applyPeopleSelectionToDom({ scroll: false });

  if (els.peopleStatus) {
    els.peopleStatus.textContent = `Showing ${filtered.length} of ${people.length}.`;
  }
}

async function ensurePeopleLoaded() {
  if (state.peopleLoaded) return;
  if (!els.peopleStatus || !els.peopleList) return;

  els.peopleStatus.textContent = 'Loading people…';
  try {
    // 50k hard limit on the endpoint; typical trees are much smaller (you have ~4k).
    const r = await fetch('/people?limit=50000&offset=0');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    state.people = results;
    state.peopleLoaded = true;
    _renderPeopleList(results, els.peopleSearch?.value || '');
    // In case a person was selected from the graph before the People tab loaded.
    _applyPeopleSelectionToDom({ scroll: true });
  } catch (e) {
    els.peopleStatus.textContent = `Failed to load people: ${e?.message || e}`;
  }
}

// Load people list lazily when the People tab is opened.
const peopleTabBtn = document.querySelector('.tabbtn[data-tab="people"]');
if (peopleTabBtn) {
  peopleTabBtn.addEventListener('click', () => {
    ensurePeopleLoaded();
  });
}

if (els.peopleSearch) {
  els.peopleSearch.addEventListener('input', () => {
    if (!state.peopleLoaded || !state.people) return;
    _renderPeopleList(state.people, els.peopleSearch.value);
  });
}
