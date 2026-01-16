import { getGraphviz } from './graphviz.js';
import { enableSvgPanZoom } from './panzoom.js';
import {
  computeHiddenChildFamiliesByPersonId,
  computeHiddenParentFamiliesByPersonId,
} from './payload.js';
import { buildRelationshipDot } from './dot.js';

function reorderGraphvizLayers(svg) {
  const containers = Array.from(svg.querySelectorAll('g')).filter(g => {
    const kids = Array.from(g.children);
    return kids.some(k => k.classList?.contains('edge')) && kids.some(k => k.classList?.contains('node'));
  });

  for (const g of containers) {
    const kids = Array.from(g.children);
    const firstNode = kids.find(k => k.classList?.contains('node'));
    if (!firstNode) continue;
    for (const k of kids) {
      if (k.classList?.contains('edge')) {
        g.insertBefore(k, firstNode);
      }
    }
  }
}

function normalizeIdFromGraphvizTitle(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  return t.replace(/^node\s+/i, '').trim();
}

function postProcessGraphvizSvg(svg, {
  personMetaById = new Map(),
  familyMetaById = new Map(),
  onExpandParents,
  onExpandChildren,
} = {}) {
  const nodes = svg.querySelectorAll('g.node');

  const familyHubDyById = new Map();
  const familyHubDxById = new Map();

  // --- Family hubs (⚭): detect only (do not move) ---
  try {
    for (const node of nodes) {
      const ellipse = node.querySelector('ellipse');
      if (!ellipse) continue;
      const titleRaw = node.querySelector('title')?.textContent?.trim();
      const title = normalizeIdFromGraphvizTitle(titleRaw);
      if (!title) continue;

      const labelText = (node.querySelector('text')?.textContent || '').trim();
      const fill = (ellipse.getAttribute('fill') || '').trim().toLowerCase();
      const isHub = (labelText === '⚭') || (fill === '#9d7bff');
      if (!isHub) continue;

      // Track hub IDs for edge snapping when smoothing is enabled.
      familyHubDyById.set(title, 0);
    }
  } catch (_) {}

  // --- Person cards: paint Gramps-like rim + add expand affordances ---
  for (const node of nodes) {
    if (node.querySelector('ellipse')) continue;
    try {
      const titleRaw = node.querySelector('title')?.textContent?.trim();
      const pid = normalizeIdFromGraphvizTitle(titleRaw);
      if (!pid) continue;

      const meta = personMetaById?.get(String(pid)) || null;
      if (!meta) continue;

      // Rim overlay
      if (!node.querySelector('[data-rim="1"]')) {
        let rim = '#93A7BF';
        if (meta.gender === 'F') rim = '#C7A0AA';
        if (meta.gender === 'U') rim = '#B7B0A3';
        if (meta.isPrivate) rim = '#D1B38B';

        const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
        if (shape && typeof shape.getBBox === 'function') {
          const ns = 'http://www.w3.org/2000/svg';
          try {
            shape.setAttribute('stroke', 'none');
            shape.setAttribute('fill', 'none');
          } catch (_) {}

          const bb = shape.getBBox();
          const x0 = bb.x;
          const y0 = bb.y;
          const w = bb.width;
          const h = bb.height;

          const corner = Math.max(4, Math.min(12, Math.min(w, h) * 0.12));
          const cornerOuter = Math.min(corner * 2, Math.min(w, h) / 2);
          const rimH = Math.max(2, Math.min(4, h * 0.05));
          const cornerInner = Math.max(2, cornerOuter - rimH);

          const roundedRectPath = (x, y, w0, h0, r) => {
            const xA = x;
            const yA = y;
            const xB = x + w0;
            const yB = y + h0;
            const rr = Math.max(0, Math.min(r, Math.min(w0, h0) / 2));
            return [
              `M ${xA + rr} ${yA}`,
              `H ${xB - rr}`,
              `A ${rr} ${rr} 0 0 1 ${xB} ${yA + rr}`,
              `V ${yB - rr}`,
              `A ${rr} ${rr} 0 0 1 ${xB - rr} ${yB}`,
              `H ${xA + rr}`,
              `A ${rr} ${rr} 0 0 1 ${xA} ${yB - rr}`,
              `V ${yA + rr}`,
              `A ${rr} ${rr} 0 0 1 ${xA + rr} ${yA}`,
              'Z'
            ].join(' ');
          };

          const dFullInner = roundedRectPath(x0, y0, w, h, cornerInner);
          const dFullOuter = roundedRectPath(x0, y0, w, h, cornerOuter);

          const baseCard = document.createElementNS(ns, 'path');
          baseCard.setAttribute('d', dFullOuter);
          baseCard.setAttribute('fill', '#d0d5dd');
          baseCard.setAttribute('stroke', 'none');
          baseCard.setAttribute('opacity', '1');
          baseCard.setAttribute('data-rim', '1');

          const rimFull = document.createElementNS(ns, 'path');
          rimFull.setAttribute('d', dFullOuter);
          rimFull.setAttribute('fill', rim);
          rimFull.setAttribute('stroke', 'none');
          rimFull.setAttribute('opacity', '1');
          rimFull.setAttribute('data-rim', '1');

          const rimCut = document.createElementNS(ns, 'path');
          rimCut.setAttribute('d', dFullInner);
          rimCut.setAttribute('fill', '#d0d5dd');
          rimCut.setAttribute('stroke', 'none');
          rimCut.setAttribute('opacity', '1');
          rimCut.setAttribute('transform', `translate(0 ${rimH})`);
          rimCut.setAttribute('data-rim', '1');

          const firstText = node.querySelector('text');
          if (firstText) {
            node.insertBefore(rimCut, firstText);
            node.insertBefore(rimFull, rimCut);
            node.insertBefore(baseCard, rimFull);
          } else {
            node.appendChild(baseCard);
            node.appendChild(rimFull);
            node.appendChild(rimCut);
          }
        }
      }

      // Expand parents indicator (top tab)
      const parentsFamilyId = (meta.hiddenParentFamilies && meta.hiddenParentFamilies.length)
        ? String(meta.hiddenParentFamilies[0])
        : '';
      if (meta.hasHiddenParents && !node.querySelector('[data-hidden-parents-for]')) {
        const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
        if (shape && typeof shape.getBBox === 'function') {
          const bb = shape.getBBox();
          const ns = 'http://www.w3.org/2000/svg';

          const tab = document.createElementNS(ns, 'polygon');
          const cx = bb.x + bb.width / 2;
          const yTop = bb.y;

          const w = Math.max(18, Math.min(28, bb.width * 0.22));
          const tipH = 10;
          const rise = 8;
          const half = w / 2;

          const p1 = `${cx - half},${yTop + 0.5}`;
          const p2 = `${cx + half},${yTop + 0.5}`;
          const p3 = `${cx + half * 0.70},${yTop - rise}`;
          const p4 = `${cx},${yTop - (rise + tipH)}`;
          const p5 = `${cx - half * 0.70},${yTop - rise}`;
          tab.setAttribute('points', `${p1} ${p2} ${p3} ${p4} ${p5}`);
          tab.setAttribute('fill', '#7aa2ff');
          tab.setAttribute('stroke', 'rgba(0,0,0,0.25)');
          tab.setAttribute('stroke-width', '1');
          tab.setAttribute('opacity', '0.90');
          tab.setAttribute('data-hidden-parents-for', String(pid));
          if (parentsFamilyId) tab.setAttribute('data-hidden-parents-family', parentsFamilyId);
          tab.style.cursor = 'pointer';
          tab.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.25))';

          const hit = document.createElementNS(ns, 'polygon');
          const hw = w * 1.25;
          const hhalf = hw / 2;
          const hp1 = `${cx - hhalf},${yTop + 3}`;
          const hp2 = `${cx + hhalf},${yTop + 3}`;
          const hp3 = `${cx + hhalf},${yTop - (rise + tipH + 10)}`;
          const hp4 = `${cx - hhalf},${yTop - (rise + tipH + 10)}`;
          hit.setAttribute('points', `${hp1} ${hp2} ${hp3} ${hp4}`);
          hit.setAttribute('fill', 'rgba(0,0,0,0.001)');
          hit.setAttribute('stroke', 'none');
          hit.setAttribute('data-hidden-parents-for', String(pid));
          if (parentsFamilyId) hit.setAttribute('data-hidden-parents-family', parentsFamilyId);
          hit.style.cursor = 'pointer';

          const t = document.createElementNS(ns, 'title');
          t.textContent = 'Has hidden parents (click to expand)';
          tab.appendChild(t);

          const click = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onExpandParents?.({ personId: pid, familyId: parentsFamilyId });
          };
          tab.addEventListener('click', click);
          hit.addEventListener('click', click);

          const firstText = node.querySelector('text');
          if (firstText) {
            node.insertBefore(hit, firstText);
            node.insertBefore(tab, firstText);
          } else {
            node.appendChild(hit);
            node.appendChild(tab);
          }
        }
      }

      // Expand children indicator (bottom tab)
      const childrenFamilyId = (meta.hiddenChildFamilies && meta.hiddenChildFamilies.length)
        ? String(meta.hiddenChildFamilies[0])
        : '';
      if (meta.hasHiddenChildren && !node.querySelector('[data-hidden-children-for]')) {
        const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
        if (shape && typeof shape.getBBox === 'function') {
          const bb = shape.getBBox();
          const ns = 'http://www.w3.org/2000/svg';

          const tab = document.createElementNS(ns, 'polygon');
          const cx = bb.x + bb.width / 2;
          const yBot = bb.y + bb.height;

          const w = Math.max(18, Math.min(28, bb.width * 0.22));
          const tipH = 10;
          const drop = 8;
          const half = w / 2;

          const p1 = `${cx - half},${yBot - 0.5}`;
          const p2 = `${cx + half},${yBot - 0.5}`;
          const p3 = `${cx + half * 0.70},${yBot + drop}`;
          const p4 = `${cx},${yBot + (drop + tipH)}`;
          const p5 = `${cx - half * 0.70},${yBot + drop}`;
          tab.setAttribute('points', `${p1} ${p2} ${p3} ${p4} ${p5}`);
          tab.setAttribute('fill', '#7aa2ff');
          tab.setAttribute('stroke', 'rgba(0,0,0,0.25)');
          tab.setAttribute('stroke-width', '1');
          tab.setAttribute('opacity', '0.90');
          tab.setAttribute('data-hidden-children-for', String(pid));
          if (childrenFamilyId) tab.setAttribute('data-hidden-children-family', childrenFamilyId);
          tab.style.cursor = 'pointer';
          tab.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.25))';

          const hit = document.createElementNS(ns, 'polygon');
          const hw = w * 1.25;
          const hhalf = hw / 2;
          const hp1 = `${cx - hhalf},${yBot - 3}`;
          const hp2 = `${cx + hhalf},${yBot - 3}`;
          const hp3 = `${cx + hhalf},${yBot + (drop + tipH + 10)}`;
          const hp4 = `${cx - hhalf},${yBot + (drop + tipH + 10)}`;
          hit.setAttribute('points', `${hp1} ${hp2} ${hp3} ${hp4}`);
          hit.setAttribute('fill', 'rgba(0,0,0,0.001)');
          hit.setAttribute('stroke', 'none');
          hit.setAttribute('data-hidden-children-for', String(pid));
          if (childrenFamilyId) hit.setAttribute('data-hidden-children-family', childrenFamilyId);
          hit.style.cursor = 'pointer';

          const t = document.createElementNS(ns, 'title');
          t.textContent = 'Has hidden children (click to expand)';
          tab.appendChild(t);

          const click = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onExpandChildren?.({ personId: pid, familyId: childrenFamilyId });
          };
          tab.addEventListener('click', click);
          hit.addEventListener('click', click);

          const firstText = node.querySelector('text');
          if (firstText) {
            node.appendChild(hit);
            node.appendChild(tab);
          } else {
            node.appendChild(hit);
            node.appendChild(tab);
          }
        }
      }
    } catch (_) {}
  }

  return { familyHubDyById, familyHubDxById };
}

function enforceEdgeRounding(svg) {
  const edgeShapes = svg.querySelectorAll('g.edge path, g.edge polyline, g.edge line');
  for (const el of edgeShapes) {
    try {
      el.style.setProperty('stroke-linecap', 'round', 'important');
      el.style.setProperty('stroke-linejoin', 'round', 'important');
    } catch (_) {}
  }
}

function convertEdgeElbowsToRoundedPaths(svg, { familyHubDyById, familyHubDxById, peopleIds, familyIds } = {}) {
  const edgeGroups = Array.from(svg.querySelectorAll('g.edge'));
  if (!edgeGroups.length) return;

  const ns = 'http://www.w3.org/2000/svg';
  const hubGeomById = new Map();

  try {
    for (const node of svg.querySelectorAll('g.node')) {
      const ellipse = node.querySelector('ellipse');
      if (!ellipse) continue;
      const id = normalizeIdFromGraphvizTitle(node.querySelector('title')?.textContent?.trim());
      if (!id) continue;
      const labelText = (node.querySelector('text')?.textContent || '').trim();
      const fill = (ellipse.getAttribute('fill') || '').trim().toLowerCase();
      const isHub = (labelText === '⚭') || (fill === '#9d7bff');
      if (!isHub) continue;
      if (typeof ellipse.getBBox !== 'function') continue;
      const bb = ellipse.getBBox();
      if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) continue;
      const rx = bb.width / 2;
      const ry = bb.height / 2;
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0) continue;
      hubGeomById.set(id, { cx: bb.x + rx, cy: bb.y + ry, rx, ry });
    }
  } catch (_) {}

  const isPerson = (id) => !!id && (peopleIds?.has(id) ?? false);
  const isFamily = (id) => !!id && (familyIds?.has(id) ?? false);

  const parsePoints = (s) => {
    const pts = [];
    const parts = String(s || '').trim().split(/\s+/g);
    for (const part of parts) {
      const [xStr, yStr] = part.split(',');
      const x = Number(xStr);
      const y = Number(yStr);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
    }
    return pts;
  };

  const parsePathPoints = (d) => {
    const s = String(d || '').trim();
    if (!s) return null;
    if (/[a]/i.test(s)) return null;
    const tok = s.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
    if (!tok || tok.length < 3) return null;
    const pts = [];
    let i = 0;
    let cmd = null;
    let x = 0;
    let y = 0;

    const readNum = () => {
      const v = Number(tok[i]);
      if (!Number.isFinite(v)) return null;
      i += 1;
      return v;
    };

    const push = (nx, ny) => {
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
      x = nx;
      y = ny;
      pts.push({ x, y });
      return true;
    };

    const isCmd = (t) => /^[a-zA-Z]$/.test(t);

    while (i < tok.length) {
      const t = tok[i];
      if (isCmd(t)) {
        cmd = t;
        i += 1;
        continue;
      }
      if (!cmd) return null;
      const c = cmd;
      if (c === c.toLowerCase()) return null;

      if (c === 'M') {
        const nx = readNum();
        const ny = readNum();
        if (nx === null || ny === null) return null;
        if (!push(nx, ny)) return null;
        cmd = 'L';
        continue;
      }
      if (c === 'L') {
        const nx = readNum();
        const ny = readNum();
        if (nx === null || ny === null) return null;
        if (!push(nx, ny)) return null;
        continue;
      }
      if (c === 'H') {
        const nx = readNum();
        if (nx === null) return null;
        if (!push(nx, y)) return null;
        continue;
      }
      if (c === 'V') {
        const ny = readNum();
        if (ny === null) return null;
        if (!push(x, ny)) return null;
        continue;
      }
      if (c === 'C') {
        const x1 = readNum();
        const y1 = readNum();
        const x2 = readNum();
        const y2 = readNum();
        const nx = readNum();
        const ny = readNum();
        if ([x1, y1, x2, y2, nx, ny].some(v => v === null)) return null;
        if (!push(nx, ny)) return null;
        continue;
      }
      if (c === 'S' || c === 'Q') {
        const a = readNum();
        const b = readNum();
        const nx = readNum();
        const ny = readNum();
        if ([a, b, nx, ny].some(v => v === null)) return null;
        if (!push(nx, ny)) return null;
        continue;
      }
      if (c === 'T') {
        const nx = readNum();
        const ny = readNum();
        if (nx === null || ny === null) return null;
        if (!push(nx, ny)) return null;
        continue;
      }
      return null;
    }

    const compact = [];
    for (const p of pts) {
      const prev = compact[compact.length - 1];
      if (!prev || prev.x !== p.x || prev.y !== p.y) compact.push(p);
    }
    return compact.length >= 2 ? compact : null;
  };

  const extractEdgeKey = (g) => {
    const title = g.querySelector('title')?.textContent?.trim() || '';
    if (!title.includes('->')) return { source: title || 'edge', target: '' };
    const [a, b] = title.split('->');
    return { source: normalizeIdFromGraphvizTitle(a), target: normalizeIdFromGraphvizTitle(b) };
  };

  const pickStrokeEl = (g) => {
    const cand = g.querySelectorAll('path, polyline, line');
    for (const el of cand) {
      const tag = el.tagName?.toLowerCase?.();
      if (tag !== 'path' && tag !== 'polyline' && tag !== 'line') continue;
      const fill = (el.getAttribute('fill') || '').trim().toLowerCase();
      const stroke = (el.getAttribute('stroke') || '').trim().toLowerCase();
      if (fill && fill !== 'none') continue;
      if (!stroke || stroke === 'none') continue;
      return el;
    }
    return null;
  };

  const smoothVerticalConnectorD = ({ source, target, offsetX = 0 }) => {
    const sx = source.x;
    const sy = source.y;
    const tx = target.x;
    const ty = target.y;
    const midY = (sy + ty) / 2;
    const ox = Number.isFinite(offsetX) ? offsetX : 0;
    // Match Gramps Web: d3-shape linkVertical().
    return `M ${sx} ${sy} C ${sx + ox} ${midY}, ${tx + ox} ${midY}, ${tx} ${ty}`;
  };

  const replaceWithSmoothPath = (el, pts, offsetX) => {
    if (!pts || pts.length < 2) return;
    // Preserve Graphviz's splay/routing by using only the first+last path points.
    const ends = { source: pts[0], target: pts[pts.length - 1] };
    const d = smoothVerticalConnectorD({ ...ends, offsetX: offsetX || 0 });
    if (!d) return;

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);

    const cs = getComputedStyle(el);
    const stroke = el.getAttribute('stroke') || cs.stroke || '#556277';
    const sw = el.getAttribute('stroke-width') || cs.strokeWidth || '1.6';
    const op = el.getAttribute('stroke-opacity') || cs.strokeOpacity || null;

    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', sw);
    if (op !== null && op !== undefined && String(op).length) path.setAttribute('stroke-opacity', String(op));

    path.style.setProperty('stroke-linecap', 'round', 'important');
    path.style.setProperty('stroke-linejoin', 'round', 'important');

    if (el.getAttribute('class')) path.setAttribute('class', el.getAttribute('class'));

    el.replaceWith(path);
  };

  const edgeInfos = [];
  for (const g of edgeGroups) {
    const el = pickStrokeEl(g);
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    const { source, target } = extractEdgeKey(g);

    // Smooth relationship edges in the Gramps style.
    // We smooth both:
    // - family -> person (children)
    // - person -> family (parents/spouse→hub)
    // This keeps single-parent→hub edges pretty in messy views.
    if (!((isFamily(source) && isPerson(target)) || (isPerson(source) && isFamily(target)))) continue;

    let pts = null;
    if (tag === 'polyline') {
      pts = parsePoints(el.getAttribute('points'));
    } else if (tag === 'line') {
      const x1 = Number(el.getAttribute('x1'));
      const y1 = Number(el.getAttribute('y1'));
      const x2 = Number(el.getAttribute('x2'));
      const y2 = Number(el.getAttribute('y2'));
      if ([x1, y1, x2, y2].every(Number.isFinite)) pts = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    } else if (tag === 'path') {
      pts = parsePathPoints(el.getAttribute('d'));
    }
    if (!pts || pts.length < 2) continue;
    edgeInfos.push({ el, pts, source, target });
  }

  const groupsBySource = new Map();
  for (const e of edgeInfos) {
    const key = e.source || 'edge';
    const arr = groupsBySource.get(key) || [];
    arr.push(e);
    groupsBySource.set(key, arr);
  }

  const FAN_DELTA = 0;
  for (const [, arr] of groupsBySource.entries()) {
    arr.sort((a, b) => String(a.target).localeCompare(String(b.target)));
    const mid = (arr.length - 1) / 2;
    for (let idx = 0; idx < arr.length; idx++) {
      const e = arr[idx];
      const offset = (idx - mid) * FAN_DELTA;
      try {
        replaceWithSmoothPath(e.el, e.pts, offset);
      } catch (_) {}
    }
  }
}

export async function renderRelationshipChart({
  container,
  payload,
  onSelectPerson,
  onExpandParents,
  onExpandChildren,
  onFit,
}) {
  const gv = await getGraphviz();
  const dot = buildRelationshipDot(payload, { couplePriority: true });

  const svgText = (typeof gv.layout === 'function')
    ? gv.layout(dot, 'svg', 'dot')
    : gv.dot(dot);

  container.innerHTML = svgText;
  const svg = container.querySelector('svg');
  if (!svg) return { panZoom: null };

  svg.style.display = 'block';
  svg.style.maxWidth = 'none';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.style.touchAction = 'none';

  const panZoom = enableSvgPanZoom(svg, { container });

  reorderGraphvizLayers(svg);

  const hiddenParents = computeHiddenParentFamiliesByPersonId(payload);
  const hiddenChildren = computeHiddenChildFamiliesByPersonId(payload);

  const personMetaById = new Map();
  for (const n of payload?.nodes || []) {
    if (n?.type !== 'person') continue;
    const pid = String(n.id || '').trim();
    if (!pid) continue;
    const isPrivate = (n.display_name === 'Private');
    const up = hiddenParents.get(pid) || [];
    const down = hiddenChildren.get(pid) || [];
    personMetaById.set(pid, {
      gender: String(n.gender || 'U').toUpperCase(),
      isPrivate,
      hasHiddenParents: up.length > 0,
      hiddenParentFamilies: up,
      hasHiddenChildren: down.length > 0,
      hiddenChildFamilies: down,
    });
  }

  const familyMetaById = new Map();
  for (const n of payload?.nodes || []) {
    if (n?.type !== 'family') continue;
    const fid = String(n.id || '').trim();
    if (!fid) continue;
    familyMetaById.set(fid, { parents_total: (n.parents_total ?? null) });
  }

  const peopleIds = new Set((payload?.nodes || []).filter(n => n?.type === 'person').map(n => String(n.id)));
  const familyIds = new Set((payload?.nodes || []).filter(n => n?.type === 'family').map(n => String(n.id)));

  const post = postProcessGraphvizSvg(svg, {
    personMetaById,
    familyMetaById,
    onExpandParents,
    onExpandChildren,
  });
  // Gramps Web style: keep Graphviz splay, but smooth the edge geometry.
  try { enforceEdgeRounding(svg); } catch (_) {}
  try { convertEdgeElbowsToRoundedPaths(svg, { ...post, peopleIds, familyIds }); } catch (_) {}

  // Click handlers
  for (const node of svg.querySelectorAll('g.node')) {
    const id = normalizeIdFromGraphvizTitle(node.querySelector('title')?.textContent?.trim());
    if (!id) continue;
    if (peopleIds.has(id)) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        // Let expand tabs win.
        if (e?.target?.closest && e.target.closest('[data-hidden-parents-for],[data-hidden-children-for]')) return;
        onSelectPerson?.(id);
      });
      continue;
    }
    if (familyIds.has(id)) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => onExpandChildren?.({ familyId: id }));
    }
  }

  // Fit shortcut for callers.
  if (onFit) {
    onFit(() => panZoom.reset());
  }

  return { panZoom };
}
