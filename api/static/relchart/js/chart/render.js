import { getGraphviz } from './graphviz.js';
import { enableSvgPanZoom } from './panzoom.js';
import {
  computeHiddenChildFamiliesByPersonId,
  computeHiddenParentFamiliesByPersonId,
} from './payload.js';
import { buildRelationshipDot } from './dot.js';

const HUB_EXTRA_LOWER_PX = 6;

// Minimum horizontal gap (in SVG units) between spouse cards for "special" couples
// where one spouse is also the parent in a single-parent family.
const SPECIAL_COUPLE_MIN_SPOUSE_GAP_PX = 17;

// --- Person card typography knobs (tweak by hand) ---
// Positive values move the block DOWN; negative move UP.
const PERSON_CARD_TEXT_TOP_SHIFT_PX = 6;
const PERSON_CARD_TEXT_BOTTOM_SHIFT_PX = 4;

// Rim-safe padding inside the card before text starts.
const PERSON_CARD_TEXT_PAD_TOP_PX = 14;
const PERSON_CARD_TEXT_PAD_BOTTOM_PX = 10;

// Horizontal alignment ("book-like" left align).
// This is the x-position (in SVG units) from the left edge of the card.
const PERSON_CARD_TEXT_LEFT_PAD_PX = 12;

// Line spacing (derived from Graphviz output, then scaled/clamped).
const PERSON_CARD_TEXT_STEP_SCALE = 0.82;
const PERSON_CARD_TEXT_STEP_MIN_PX = 12;
const PERSON_CARD_TEXT_STEP_MAX_PX = 16;

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
  familyMetaById: _familyMetaById = new Map(),
  familyParentsById = new Map(),
  singleParentParentByFamily = new Map(),
  onExpandParents,
  onExpandChildren,
} = {}) {
  const nodes = svg.querySelectorAll('g.node');

  const familyHubDyById = new Map();
  const familyHubDxById = new Map();

  const parseTranslate = (t) => {
    const s = String(t || '').trim();
    if (!s) return null;
    const m = s.match(/translate\(\s*([-+]?\d*\.?\d+)(?:[\s,]+([-+]?\d*\.?\d+))?\s*\)/i);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2] ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  };

  // getBBox() does NOT account for SVG transforms (e.g. Graphviz uses translate(...) on g.node).
  // For layout math we need boxes in the SVG user coordinate space.
  const bboxInUserSpace = (el) => {
    try {
      if (!el) return null;

      // Most reliable: use screen-space rect, then map back into SVG user-space.
      // This accounts for nested transforms even when getCTM()/createSVGPoint behave oddly.
      const r = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const screenCTM = (svg && typeof svg.getScreenCTM === 'function') ? svg.getScreenCTM() : null;
      if (r && screenCTM && Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom)) {
        let inv = null;
        try { inv = screenCTM.inverse(); } catch (_) { inv = null; }
        const xform = (x, y) => {
          try {
            if (inv && typeof DOMPoint === 'function') {
              return new DOMPoint(x, y).matrixTransform(inv);
            }
          } catch (_) {}
          return null;
        };

        const pts = [
          xform(r.left, r.top),
          xform(r.right, r.top),
          xform(r.left, r.bottom),
          xform(r.right, r.bottom),
        ].filter(Boolean);

        if (pts.length >= 2) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of pts) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
          if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
            return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
          }
        }
      }

      // Fallback: best-effort local bbox.
      if (typeof el.getBBox === 'function') {
        const bb = el.getBBox();
        if (bb && Number.isFinite(bb.x) && Number.isFinite(bb.y) && Number.isFinite(bb.width) && Number.isFinite(bb.height)) return bb;
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  // Estimate a typical person-card height in SVG units so we can place the hub
  // near the bottom edge of spouse cards (Gramps Web / old graph feel).
  let typicalPersonCardHeight = null;
  try {
    const hs = [];
    for (const node of nodes) {
      if (node.querySelector('ellipse')) continue;
      const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
      if (!shape || typeof shape.getBBox !== 'function') continue;
      const bb = shape.getBBox();
      if (!bb || !Number.isFinite(bb.height) || bb.height <= 0) continue;
      hs.push(bb.height);
      if (hs.length >= 25) break;
    }
    hs.sort((a, b) => a - b);
    if (hs.length) typicalPersonCardHeight = hs[Math.floor(hs.length / 2)];
  } catch (_) {}

  // Precompute person card anchors for later adjustments (single-parent junctions + hub centering).
  const personBottomCenterById = new Map();
  const personCenterById = new Map();
  const personNodeById = new Map();
  const personShapeById = new Map();
  try {
    for (const node of nodes) {
      if (node.querySelector('ellipse')) continue;
      const id = normalizeIdFromGraphvizTitle(node.querySelector('title')?.textContent?.trim());
      if (!id) continue;

      const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
      if (!shape || typeof shape.getBBox !== 'function') continue;
      const bb = bboxInUserSpace(shape);
      if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) continue;
      if (bb.width <= 0 || bb.height <= 0) continue;
      personBottomCenterById.set(id, { x: bb.x + bb.width / 2, y: bb.y + bb.height });
      personCenterById.set(id, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
      personNodeById.set(id, node);
      personShapeById.set(id, shape);
    }
  } catch (_) {}

  // For single-parent families we hide the hub and use an invisible family node as
  // a junction. Move that junction directly under the parent's card center so
  // child lines originate from the bottom-center of the parent.
  try {
    for (const [fid, pid] of (singleParentParentByFamily || new Map()).entries()) {
      const parent = String(pid || '').trim();
      const bc = personBottomCenterById.get(parent);
      if (!bc || !Number.isFinite(bc.x) || !Number.isFinite(bc.y)) continue;

      const famNode = Array.from(nodes).find(n => {
        const t = normalizeIdFromGraphvizTitle(n.querySelector('title')?.textContent?.trim());
        return t === String(fid);
      });
      if (!famNode) continue;

      const bb = bboxInUserSpace(famNode);
      if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) continue;

      const cur = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
      const gap = Math.max(6, Math.min(14, (typicalPersonCardHeight || 120) * 0.10));
      const desired = { x: bc.x, y: bc.y + gap };

      const dx = desired.x - cur.x;
      const dy = desired.y - cur.y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
        familyHubDxById.set(String(fid), 0);
        familyHubDyById.set(String(fid), 0);
        continue;
      }

      try {
        const tr = parseTranslate(famNode.getAttribute('transform'));
        if (tr) {
          famNode.setAttribute('transform', `translate(${tr.x + dx} ${tr.y + dy})`);
        } else {
          famNode.setAttribute('transform', `translate(${dx} ${dy})`);
        }
      } catch (_) {}

      // Reuse the hub offset maps for snapping edge endpoints.
      familyHubDxById.set(String(fid), dx);
      familyHubDyById.set(String(fid), dy);
    }
  } catch (_) {}

  // --- Nudge spouse cards apart for "special" couples ---
  // Track person-card X offsets so edge endpoints can be updated later.
  const personDxById = new Map();
  try {
    // People who are parents in any single-parent family (in-view).
    const hasSingleParentFamilyByPerson = new Set();
    for (const [, pid] of (singleParentParentByFamily || new Map()).entries()) {
      const p = String(pid || '').trim();
      if (p) hasSingleParentFamilyByPerson.add(p);
    }

    // For each couple where one spouse is in a single-parent family, check if
    // their cards are too close and nudge them apart symmetrically.
    for (const [, parents] of (familyParentsById || new Map()).entries()) {
      const aId = String(parents?.fatherId || '').trim();
      const bId = String(parents?.motherId || '').trim();
      if (!aId || !bId) continue;

      const needsExtraGap = hasSingleParentFamilyByPerson.has(aId) || hasSingleParentFamilyByPerson.has(bId);
      if (!needsExtraGap) continue;

      const aShape = personShapeById.get(aId);
      const bShape = personShapeById.get(bId);
      if (!aShape || !bShape) continue;

      const abb = bboxInUserSpace(aShape);
      const bbb = bboxInUserSpace(bShape);
      if (!abb || !bbb) continue;
      if (!Number.isFinite(abb.x) || !Number.isFinite(abb.width) || !Number.isFinite(bbb.x) || !Number.isFinite(bbb.width)) continue;

      // Determine which spouse is on the left.
      const leftId = (abb.x <= bbb.x) ? aId : bId;
      const rightId = (leftId === aId) ? bId : aId;
      const leftBB = (leftId === aId) ? abb : bbb;
      const rightBB = (rightId === aId) ? abb : bbb;

      const currentGap = rightBB.x - (leftBB.x + leftBB.width);
      if (currentGap >= SPECIAL_COUPLE_MIN_SPOUSE_GAP_PX) continue;

      // Nudge each spouse outward by half the shortfall.
      const shortfall = SPECIAL_COUPLE_MIN_SPOUSE_GAP_PX - currentGap;
      const nudge = shortfall / 2;

      // Move left spouse left, right spouse right.
      const leftNode = personNodeById.get(leftId);
      const rightNode = personNodeById.get(rightId);
      if (!leftNode || !rightNode) continue;

      try {
        const trL = parseTranslate(leftNode.getAttribute('transform'));
        if (trL) {
          leftNode.setAttribute('transform', `translate(${trL.x - nudge} ${trL.y})`);
        } else {
          leftNode.setAttribute('transform', `translate(${-nudge} 0)`);
        }
        personDxById.set(leftId, (personDxById.get(leftId) || 0) - nudge);
      } catch (_) {}

      try {
        const trR = parseTranslate(rightNode.getAttribute('transform'));
        if (trR) {
          rightNode.setAttribute('transform', `translate(${trR.x + nudge} ${trR.y})`);
        } else {
          rightNode.setAttribute('transform', `translate(${nudge} 0)`);
        }
        personDxById.set(rightId, (personDxById.get(rightId) || 0) + nudge);
      } catch (_) {}
    }
  } catch (_) {}

  // --- Family hubs (⚭): detect only (do not move) ---
  try {
    const hubNodes = [];

    // People who are parents in any single-parent family (in-view).
    // This correlates with DOT occasionally packing a separate couple too tightly.
    const hasSingleParentFamilyByPerson = new Set();
    try {
      for (const [, pid] of (singleParentParentByFamily || new Map()).entries()) {
        const p = String(pid || '').trim();
        if (p) hasSingleParentFamilyByPerson.add(p);
      }
    } catch (_) {}

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

      hubNodes.push(node);

      // Whether this hub belongs to a "special" couple where we want extra horizontal breathing room.
      // (Do not change vertical placement for these; only spacing.)
      let needsExtraGapForThisHub = false;

      let dy = 0;
      try {
        if (typicalPersonCardHeight && typeof ellipse.getBBox === 'function') {
          const bb = ellipse.getBBox();
          const ry = (bb && Number.isFinite(bb.height)) ? (bb.height / 2) : 0;
          if (Number.isFinite(ry) && ry > 0) {
            const bottomGap = Math.max(1, Math.min(4, typicalPersonCardHeight * 0.02));
            dy = Math.max(0, (typicalPersonCardHeight / 2) - ry - bottomGap);
            dy = Math.min(dy, typicalPersonCardHeight * 0.45);
          }
        }
      } catch (_) {}

      if (dy > 0) dy += HUB_EXTRA_LOWER_PX;

      // Also center the hub horizontally between spouses (if both are present).
      // This prevents odd cases where other constraints (e.g. single-parent junctions)
      // cause DOT to place the hub to the left/right of the couple.
      let dx = 0;
      try {
        const parents = familyParentsById?.get(title) || null;
        const aId = String(parents?.fatherId || '').trim();
        const bId = String(parents?.motherId || '').trim();
        if (aId && bId) {
          needsExtraGapForThisHub = hasSingleParentFamilyByPerson.has(aId) || hasSingleParentFamilyByPerson.has(bId);

          // Center hub between current spouse card centers.
          const aShape2 = personShapeById.get(aId);
          const bShape2 = personShapeById.get(bId);
          const abb2 = aShape2 ? bboxInUserSpace(aShape2) : null;
          const bbb2 = bShape2 ? bboxInUserSpace(bShape2) : null;
          const ebb0 = bboxInUserSpace(ellipse);
          if (abb2 && bbb2 && ebb0 && Number.isFinite(abb2.x) && Number.isFinite(abb2.width) && Number.isFinite(bbb2.x) && Number.isFinite(bbb2.width) && Number.isFinite(ebb0.width)) {
            const aCx = abb2.x + abb2.width / 2;
            const bCx = bbb2.x + bbb2.width / 2;
            const desiredCenterX = (aCx + bCx) / 2;

            // Clamp hub so it stays between spouse cards with a small visible gap.
            const leftBB = (abb2.x <= bbb2.x) ? abb2 : bbb2;
            const rightBB = (leftBB === abb2) ? bbb2 : abb2;
            const minSideGap = needsExtraGapForThisHub ? 30 : 0;
            const minHubX = leftBB.x + leftBB.width + minSideGap;
            const maxHubX = rightBB.x - minSideGap - ebb0.width;

            let desiredHubX = desiredCenterX - (ebb0.width / 2);
            if (Number.isFinite(minHubX) && Number.isFinite(maxHubX) && minHubX <= maxHubX) {
              desiredHubX = Math.max(minHubX, Math.min(maxHubX, desiredHubX));
            }
            const desiredHubCenterX = desiredHubX + (ebb0.width / 2);

            const curCenterX = (Number.isFinite(ebb0.x) && Number.isFinite(ebb0.width)) ? (ebb0.x + (ebb0.width / 2)) : null;
            if (curCenterX !== null && Number.isFinite(curCenterX)) dx = desiredHubCenterX - curCenterX;
          }
        }
      } catch (_) {}

      // Slightly enlarge the hub to fill the natural gap between hub and spouse cards.
      // This gives couples a consistent "tight" look.
      try {
        const rx0 = Number(ellipse.getAttribute('rx'));
        const ry0 = Number(ellipse.getAttribute('ry'));
        if (Number.isFinite(rx0) && Number.isFinite(ry0) && rx0 > 0 && ry0 > 0) {
          const bump = 2;
          ellipse.setAttribute('rx', String(rx0 + bump));
          ellipse.setAttribute('ry', String(ry0 + bump));
        }
      } catch (_) {}

      // Apply translation to move hub lower.
      try {
        if (dx !== 0 || dy > 0) {
          const tr = parseTranslate(node.getAttribute('transform'));
          if (tr) {
            node.setAttribute('transform', `translate(${tr.x + dx} ${tr.y + dy})`);
          } else {
            // Graphviz often encodes node geometry as absolute cx/cy/points with no
            // group transform at all. In that case, add a translate so the hub
            // actually moves.
            node.setAttribute('transform', `translate(${dx} ${dy})`);
          }
        }
      } catch (_) {}

      // Track hub offsets for edge smoothing endpoint snapping.
      familyHubDyById.set(title, dy);
      familyHubDxById.set(title, dx);
    }

    // Ensure hubs are painted above person cards.
    // Some nodes can overlap after we enlarge/lower hubs; SVG z-order is DOM order.
    // Moving hubs to the end of their parent group brings them to the front.
    try {
      for (const node of hubNodes) {
        const parent = node.parentNode;
        if (parent && parent.appendChild) parent.appendChild(node);
      }
    } catch (_) {}
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

      try { node.classList.add('personNode'); } catch (_) {}

      // Text layout: keep names at top, dates at bottom, and reduce line spacing.
      try {
        const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
        if (shape && typeof shape.getBBox === 'function') {
          const bb = shape.getBBox();
          if (bb && Number.isFinite(bb.x) && Number.isFinite(bb.y) && Number.isFinite(bb.width) && Number.isFinite(bb.height)) {
            const texts = Array.from(node.querySelectorAll('text'))
              .filter(t => {
                // Ignore edge labels / stray SVG text; keep only label rows.
                const s = String(t.textContent || '').trim();
                if (!s) return false;
                return true;
              })
              .map(t => {
                const y = Number(t.getAttribute('y'));
                const s = String(t.textContent || '').trim();
                const fw = String(t.getAttribute('font-weight') || '').trim().toLowerCase();
                const isBold = (fw === 'bold') || (fw === '600') || (fw === '700');
                const isDate = s.startsWith('*') || s.startsWith('†') || s.startsWith('\u2020');
                return { t, y, s, isBold, isDate };
              })
              .filter(x => Number.isFinite(x.y));

            if (texts.length >= 2) {
              // Compute portrait offset — if this card has a portrait, shift text right
              // by the portrait image width + margins so text stays within the right
              // portion of the widened card.
              let portraitTextOffset = 0;
              if (meta.portraitUrl) {
                const rimH = 6;
                const portraitPad = 10;  // left margin doubled
                const portraitSz = bb.height - rimH - portraitPad * 2;
                portraitTextOffset = portraitSz + portraitPad + 4;
              }

              // Align text to the left edge of the card (plus portrait offset).
              const xLeft = bb.x + PERSON_CARD_TEXT_LEFT_PAD_PX + portraitTextOffset;
              for (const item of texts) {
                try {
                  item.t.setAttribute('text-anchor', 'start');
                  item.t.setAttribute('x', String(xLeft));
                } catch (_) {}
              }

              const ys = texts.map(x => x.y).sort((a, b) => a - b);
              const diffs = [];
              for (let i = 1; i < ys.length; i++) {
                const d = ys[i] - ys[i - 1];
                if (Number.isFinite(d) && d > 0.1 && d < bb.height) diffs.push(d);
              }
              diffs.sort((a, b) => a - b);
              const typicalStep = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 14;
              const step = Math.max(
                PERSON_CARD_TEXT_STEP_MIN_PX,
                Math.min(PERSON_CARD_TEXT_STEP_MAX_PX, typicalStep * PERSON_CARD_TEXT_STEP_SCALE)
              );

              const nameLines = texts.filter(x => x.isBold && !x.isDate).sort((a, b) => a.y - b.y);
              const dateLines = texts.filter(x => x.isDate).sort((a, b) => a.y - b.y);
              const otherLines = texts.filter(x => !x.isBold && !x.isDate).sort((a, b) => a.y - b.y);

              // Rim-safe padding: keep the first line from touching the colored rim.
              const padTop = Math.max(6, Math.min(18, PERSON_CARD_TEXT_PAD_TOP_PX));
              const padBot = Math.max(6, Math.min(18, PERSON_CARD_TEXT_PAD_BOTTOM_PX));

              // If no explicit name lines (should be rare), treat everything as name.
              const topBlock = nameLines.length ? nameLines : texts;

              // If there are no date lines, keep other lines (e.g. private GID) near bottom.
              const bottomBlock = dateLines.length ? dateLines : otherLines;

              // Place top block from the top down.
              let yTop = bb.y + padTop + PERSON_CARD_TEXT_TOP_SHIFT_PX;
              for (let i = 0; i < topBlock.length; i++) {
                const x = topBlock[i];
                const y = yTop + (i * step);
                x.t.setAttribute('y', String(y));
              }

              // Place bottom block from the bottom up.
              if (bottomBlock.length) {
                const lastIdx = bottomBlock.length - 1;
                let yBottomLast = (bb.y + bb.height) - padBot + PERSON_CARD_TEXT_BOTTOM_SHIFT_PX;
                for (let i = lastIdx; i >= 0; i--) {
                  const x = bottomBlock[i];
                  const y = yBottomLast - ((lastIdx - i) * step);
                  x.t.setAttribute('y', String(y));
                }
              }

              // Any remaining non-bold, non-date lines not used in bottomBlock: keep them
              // just above the date block so they don't collide with name lines.
              const used = new Set([...topBlock, ...bottomBlock].map(x => x.t));
              const leftovers = texts.filter(x => !used.has(x.t)).sort((a, b) => a.y - b.y);
              if (leftovers.length) {
                const base = (bb.y + bb.height) - padBot - (bottomBlock.length ? (bottomBlock.length * step) : 0) - (step * 0.25);
                for (let i = leftovers.length - 1; i >= 0; i--) {
                  leftovers[i].t.setAttribute('y', String(base - ((leftovers.length - 1 - i) * step)));
                }
              }
            }
          }
        }
      } catch (_) {}

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

      // Portrait thumbnail (rounded-square on the left side of the card)
      if (meta.portraitUrl && !node.querySelector('[data-portrait="1"]')) {
        const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
        if (shape && typeof shape.getBBox === 'function') {
          try {
            const bb = shape.getBBox();
            const ns = 'http://www.w3.org/2000/svg';
            const rimH = 6;  // match rim height
            const pad = 10;  // left margin (doubled from original 5)
            const sz = bb.height - rimH - pad * 2; // fill card height minus rim and padding
            const imgX = bb.x + pad;
            const imgY = bb.y + rimH + pad;
            const cornerR = Math.max(3, Math.min(8, sz * 0.12));

            // Clip rounded-rect
            const clipId = `portrait-clip-${String(pid).replace(/[^a-zA-Z0-9]/g, '_')}`;
            let defs = svg.querySelector('defs');
            if (!defs) { defs = document.createElementNS(ns, 'defs'); svg.insertBefore(defs, svg.firstChild); }

            const clipPath = document.createElementNS(ns, 'clipPath');
            clipPath.id = clipId;
            const clipRect = document.createElementNS(ns, 'rect');
            clipRect.setAttribute('x', String(imgX));
            clipRect.setAttribute('y', String(imgY));
            clipRect.setAttribute('width', String(sz));
            clipRect.setAttribute('height', String(sz));
            clipRect.setAttribute('rx', String(cornerR));
            clipRect.setAttribute('ry', String(cornerR));
            clipPath.appendChild(clipRect);
            defs.appendChild(clipPath);

            // Border rect (visible frame)
            const frame = document.createElementNS(ns, 'rect');
            frame.setAttribute('x', String(imgX - 0.5));
            frame.setAttribute('y', String(imgY - 0.5));
            frame.setAttribute('width', String(sz + 1));
            frame.setAttribute('height', String(sz + 1));
            frame.setAttribute('rx', String(cornerR + 0.5));
            frame.setAttribute('ry', String(cornerR + 0.5));
            frame.setAttribute('fill', 'none');
            frame.setAttribute('stroke', '#b0b8c8');
            frame.setAttribute('stroke-width', '1');
            frame.setAttribute('data-portrait', '1');

            // Image element
            const img = document.createElementNS(ns, 'image');
            img.setAttribute('href', meta.portraitUrl);
            img.setAttribute('x', String(imgX));
            img.setAttribute('y', String(imgY));
            img.setAttribute('width', String(sz));
            img.setAttribute('height', String(sz));
            img.setAttribute('clip-path', `url(#${clipId})`);
            img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            img.setAttribute('data-portrait', '1');

            // Insert after rim elements but before expand indicators
            const firstExpand = node.querySelector('[data-hidden-parents-for], [data-hidden-children-for]');
            if (firstExpand) {
              node.insertBefore(frame, firstExpand);
              node.insertBefore(img, firstExpand);
            } else {
              node.appendChild(frame);
              node.appendChild(img);
            }

            // Text was already shifted right during text repositioning above,
            // so no additional text movement is needed here.
          } catch (_) {}
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
            onExpandParents?.({
              personId: pid,
              familyId: parentsFamilyId,
              expandKind: 'parents',
              clientX: e?.clientX,
              clientY: e?.clientY,
            });
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
            onExpandChildren?.({
              personId: pid,
              familyId: childrenFamilyId,
              expandKind: 'children',
              clientX: e?.clientX,
              clientY: e?.clientY,
            });
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

  return { familyHubDyById, familyHubDxById, personDxById };
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

function convertEdgeElbowsToRoundedPaths(svg, { familyHubDyById, familyHubDxById, personDxById, peopleIds, familyIds, singleParentFamilyIds, singleParentParentByFamily } = {}) {
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

  const personBottomCenterById = new Map();
  const personTopCenterById = new Map();
  try {
    for (const node of svg.querySelectorAll('g.node')) {
      if (node.querySelector('ellipse')) continue;
      const id = normalizeIdFromGraphvizTitle(node.querySelector('title')?.textContent?.trim());
      if (!id) continue;
      if (!(peopleIds?.has(id) ?? false)) continue;

      const shape = node.querySelector('path') || node.querySelector('polygon') || node.querySelector('rect');
      if (!shape || typeof shape.getBBox !== 'function') continue;
      const bb = shape.getBBox();
      if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) continue;
      if (bb.width <= 0 || bb.height <= 0) continue;
      personBottomCenterById.set(id, { x: bb.x + bb.width / 2, y: bb.y + bb.height });
      personTopCenterById.set(id, { x: bb.x + bb.width / 2, y: bb.y });
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

  const replaceWithSmoothPath = (el, pts, { offsetX, sourceId, targetId } = {}) => {
    if (!pts || pts.length < 2) return;
    // Preserve Graphviz's splay/routing by using only the first+last path points.
    const ends = { source: { ...pts[0] }, target: { ...pts[pts.length - 1] } };

    // For single-parent families, make the trunk edge originate from the
    // bottom-center of the (sole) parent card (not from the side).
    try {
      const sid = String(sourceId || '');
      const tid = String(targetId || '');
      // Case A: parent -> (hidden family junction) (mostly invisible)
      if ((peopleIds?.has(sid) ?? false) && (singleParentFamilyIds?.has(tid) ?? false)) {
        const bc = personBottomCenterById.get(sid);
        if (bc && Number.isFinite(bc.x) && Number.isFinite(bc.y)) {
          ends.source.x = bc.x;
          ends.source.y = bc.y;
        }
      }

      // Case B: (hidden family junction) -> child (visible): start from parent's bottom-center.
      if ((singleParentFamilyIds?.has(sid) ?? false) && (peopleIds?.has(tid) ?? false)) {
        const parentId = String(singleParentParentByFamily?.get(sid) || '').trim();
        const bc = parentId ? personBottomCenterById.get(parentId) : null;
        if (bc && Number.isFinite(bc.x) && Number.isFinite(bc.y)) {
          ends.source.x = bc.x;
          ends.source.y = bc.y;
        }
      }

      // For child edges, always enter the child card at the top-center.
      // This avoids visible gaps caused by rounded corners when Graphviz
      // chooses an entry point near a corner.
      if ((familyIds?.has(sid) ?? false) && (peopleIds?.has(tid) ?? false)) {
        const tc = personTopCenterById.get(tid);
        if (tc && Number.isFinite(tc.x) && Number.isFinite(tc.y)) {
          ends.target.x = tc.x;
          ends.target.y = tc.y;
        }
      }
    } catch (_) {}

    // If we moved the family hubs (⚭) in SVG space, shift the corresponding
    // edge endpoints so the smoothed connectors still land on the hub.
    try {
      if (familyHubDxById && familyHubDyById) {
        const sKey = String(sourceId || '');
        const tKey = String(targetId || '');
        const sDx = Number(familyHubDxById.get(sKey) ?? 0);
        const sDy = Number(familyHubDyById.get(sKey) ?? 0);
        const tDx = Number(familyHubDxById.get(tKey) ?? 0);
        const tDy = Number(familyHubDyById.get(tKey) ?? 0);
        if (Number.isFinite(sDx) && Number.isFinite(sDy) && (sDx !== 0 || sDy !== 0)) {
          ends.source.x += sDx;
          ends.source.y += sDy;
        }
        if (Number.isFinite(tDx) && Number.isFinite(tDy) && (tDx !== 0 || tDy !== 0)) {
          ends.target.x += tDx;
          ends.target.y += tDy;
        }
      }
    } catch (_) {}

    // If we nudged person cards horizontally (for special couples), shift the
    // corresponding edge endpoints so connectors still land on the cards.
    try {
      if (personDxById) {
        const sKey = String(sourceId || '');
        const tKey = String(targetId || '');
        const sDx = Number(personDxById.get(sKey) ?? 0);
        const tDx = Number(personDxById.get(tKey) ?? 0);
        if (Number.isFinite(sDx) && sDx !== 0) {
          ends.source.x += sDx;
        }
        if (Number.isFinite(tDx) && tDx !== 0) {
          ends.target.x += tDx;
        }
      }
    } catch (_) {}

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
        replaceWithSmoothPath(e.el, e.pts, { offsetX: offset, sourceId: e.source, targetId: e.target });
      } catch (_) {}
    }
  }
}

export async function renderRelationshipChart({
  container,
  payload,
  onSelectPerson,
  onSelectFamily,
  onExpandParents,
  onExpandChildren,
  onFit,
  onViewBoxChange,
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

  const panZoom = enableSvgPanZoom(svg, { container, onChange: onViewBoxChange });

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
      portraitUrl: n.portrait_url || null,
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

  const familyParentsById = new Map();
  for (const e of payload?.edges || []) {
    if (e?.type !== 'parent') continue;
    const pid = String(e.from || '').trim();
    const fid = String(e.to || '').trim();
    if (!pid || !fid) continue;
    if (!peopleIds.has(pid) || !familyIds.has(fid)) continue;
    const cur = familyParentsById.get(fid) || { fatherId: null, motherId: null };
    if (e.role === 'father') cur.fatherId = pid;
    if (e.role === 'mother') cur.motherId = pid;
    familyParentsById.set(fid, cur);
  }

  const visibleParentCountByFamily = new Map();
  const singleParentParentByFamily = new Map();
  for (const e of payload?.edges || []) {
    if (e?.type !== 'parent') continue;
    const pid = String(e.from || '').trim();
    const fid = String(e.to || '').trim();
    if (!pid || !fid) continue;
    if (!peopleIds.has(pid) || !familyIds.has(fid)) continue;
    visibleParentCountByFamily.set(fid, (visibleParentCountByFamily.get(fid) || 0) + 1);
    // Track the parent candidate; we’ll only use it if the family ends up being single-parent.
    singleParentParentByFamily.set(fid, pid);
  }
  const singleParentFamilyIds = new Set();
  for (const [fid, n] of visibleParentCountByFamily.entries()) {
    if (Number(n) === 1) singleParentFamilyIds.add(fid);
  }

  // Prune parent mapping to only true single-parent families.
  for (const [fid] of Array.from(singleParentParentByFamily.entries())) {
    if (!singleParentFamilyIds.has(fid)) singleParentParentByFamily.delete(fid);
  }

  const post = postProcessGraphvizSvg(svg, {
    personMetaById,
    familyMetaById,
    familyParentsById,
    singleParentParentByFamily,
    onExpandParents,
    onExpandChildren,
  });
  // Gramps Web style: keep Graphviz splay, but smooth the edge geometry.
  try { enforceEdgeRounding(svg); } catch (_) {}
  try { convertEdgeElbowsToRoundedPaths(svg, { ...post, peopleIds, familyIds, singleParentFamilyIds, singleParentParentByFamily }); } catch (_) {}

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
      node.addEventListener('click', () => onSelectFamily?.(id));
    }
  }

  // Fit shortcut for callers.
  if (onFit) {
    onFit(() => panZoom.reset());
  }

  return { panZoom };
}
