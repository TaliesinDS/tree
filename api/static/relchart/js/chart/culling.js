function _rectIntersects(a, b) {
  if (!a || !b) return false;
  return !(
    (a.x + a.w) < b.x ||
    a.x > (b.x + b.w) ||
    (a.y + a.h) < b.y ||
    a.y > (b.y + b.h)
  );
}

function _rectIntersectsClient(a, b) {
  if (!a || !b) return false;
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function _normalizeGraphvizTitleToId(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  return t.replace(/^node\s+/i, '').trim();
}

function _mul(a, b) {
  // Multiply 2D affine matrices in SVG's (a b c d e f) form.
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

function _apply(m, p) {
  return {
    x: (m.a * p.x) + (m.c * p.y) + m.e,
    y: (m.b * p.x) + (m.d * p.y) + m.f,
  };
}

function _boundsToClientRect(svg, b) {
  try {
    if (!svg || !b) return null;
    const ctm = svg.getScreenCTM?.();
    if (!ctm) return null;
    const m = _matrixFromSvgMatrix(ctm);
    if (!m) return null;

    const p0 = _apply(m, { x: b.x, y: b.y });
    const p1 = _apply(m, { x: b.x + b.w, y: b.y });
    const p2 = _apply(m, { x: b.x, y: b.y + b.h });
    const p3 = _apply(m, { x: b.x + b.w, y: b.y + b.h });
    const xs = [p0.x, p1.x, p2.x, p3.x].filter(Number.isFinite);
    const ys = [p0.y, p1.y, p2.y, p3.y].filter(Number.isFinite);
    if (xs.length < 2 || ys.length < 2) return null;
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
  } catch (_) {
    return null;
  }
}

function _identity() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function _matrixFromSvgMatrix(mm) {
  if (!mm) return null;
  const a = Number(mm.a);
  const b = Number(mm.b);
  const c = Number(mm.c);
  const d = Number(mm.d);
  const e = Number(mm.e);
  const f = Number(mm.f);
  if (![a, b, c, d, e, f].every(Number.isFinite)) return null;
  return { a, b, c, d, e, f };
}

function _invert(m) {
  // Invert 2D affine (a b c d e f)
  const det = (m.a * m.d) - (m.b * m.c);
  if (!Number.isFinite(det) || det === 0) return null;
  const invDet = 1 / det;
  const a = m.d * invDet;
  const b = -m.b * invDet;
  const c = -m.c * invDet;
  const d = m.a * invDet;
  const e = -((a * m.e) + (c * m.f));
  const f = -((b * m.e) + (d * m.f));
  return { a, b, c, d, e, f };
}

function _computeUserSpaceBounds(svg, el) {
  try {
    if (!el || typeof el.getBBox !== 'function') return null;
    const bb = el.getBBox();
    if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y) || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) return null;
    if (bb.width <= 0 || bb.height <= 0) return null;

    // Map local bbox -> SVG user-space by canceling any viewBox scaling:
    // userSpace = inv(svg.getCTM()) * el.getCTM() * local
    const mElRaw = (el.getScreenCTM?.() || el.getCTM?.() || null);
    const mSvgRaw = (svg?.getScreenCTM?.() || svg?.getCTM?.() || null);
    const mEl = _matrixFromSvgMatrix(mElRaw);
    const mSvg = _matrixFromSvgMatrix(mSvgRaw);
    if (!mEl || !mSvg) return null;
    const invSvg = _invert(mSvg);
    if (!invSvg) return null;
    const m = _mul(invSvg, mEl);

    const p0 = _apply(m, { x: bb.x, y: bb.y });
    const p1 = _apply(m, { x: bb.x + bb.width, y: bb.y });
    const p2 = _apply(m, { x: bb.x, y: bb.y + bb.height });
    const p3 = _apply(m, { x: bb.x + bb.width, y: bb.y + bb.height });

    const xs = [p0.x, p1.x, p2.x, p3.x].filter(Number.isFinite);
    const ys = [p0.y, p1.y, p2.y, p3.y].filter(Number.isFinite);
    if (xs.length < 2 || ys.length < 2) return null;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const h = maxY - minY;
    if (!(w > 0) || !(h > 0)) return null;
    return { x: minX, y: minY, w, h };
  } catch (_) {
    return null;
  }
}

function _computeNodeBounds(svg, nodeEl) {
  try {
    if (!nodeEl) return null;
    // Use the primary shape bbox with CTM math.
    const shape = nodeEl.querySelector('path, polygon, rect, ellipse');
    if (!shape) return null;
    return _computeUserSpaceBounds(svg, shape);
  } catch (_) {
    return null;
  }
}

function _extractEdgeKey(edgeG) {
  const raw = edgeG?.querySelector?.('title')?.textContent?.trim?.() || '';
  if (!raw.includes('->')) return { source: '', target: '' };
  const [a, b] = raw.split('->');
  return {
    source: _normalizeGraphvizTitleToId(a),
    target: _normalizeGraphvizTitleToId(b),
  };
}

export function createViewportCuller(svg, {
  // Margin can be specified either:
  // - as a fraction of the current viewBox size (marginFactor), or
  // - in screen pixels (marginPx), converted into SVG units each update.
  // Pixel margin keeps the "pop line" roughly stable when the viewport resizes.
  marginFactor = 0.35,
  marginPx = 900,
  nodeSelector = 'g.node',
  edgeSelector = 'g.edge',
} = {}) {
  const nodeItems = [];
  const edgeItems = [];
  let enabled = false;
  let raf = 0;
  let _resizeHandlerInstalled = false;
  const _onResize = () => {
    try { scheduleUpdate(); } catch (_) {}
  };

  const _setVisible = (el, on) => {
    try {
      if (!el) return;
      el.style.display = on ? '' : 'none';
    } catch (_) {}
  };

  const _showAll = () => {
    for (const it of nodeItems) _setVisible(it.el, true);
    for (const it of edgeItems) _setVisible(it.el, true);
  };

  const _index = () => {
    nodeItems.length = 0;
    edgeItems.length = 0;
    if (!svg) return;

    // Index nodes with cached bounds in SVG user-space (same coordinate space as viewBox).
    const nodes = Array.from(svg.querySelectorAll(nodeSelector));
    for (const el of nodes) {
      const id = _normalizeGraphvizTitleToId(el.querySelector('title')?.textContent?.trim?.());
      if (!id) continue;
      const b = _computeNodeBounds(svg, el);
      if (!b) continue;
      nodeItems.push({ el, id, b });
    }

    // Index edges by endpoints only; visibility will be derived from node visibility.
    const edges = Array.from(svg.querySelectorAll(edgeSelector));
    for (const el of edges) {
      const k = _extractEdgeKey(el);
      edgeItems.push({ el, source: k.source, target: k.target });
    }
  };

  const update = (_viewBoxIgnored) => {
    if (!enabled) return;
    const vr = svg.getBoundingClientRect?.();
    if (!vr || !Number.isFinite(vr.left) || !Number.isFinite(vr.top) || !Number.isFinite(vr.right) || !Number.isFinite(vr.bottom)) return;

    const mf = Math.max(0, Number(marginFactor) || 0);
    const mp = Math.max(0, Number(marginPx) || 0);
    const mx = Math.max(mp, mf * (vr.width || 0));
    const my = Math.max(mp, mf * (vr.height || 0));
    const expanded = {
      left: vr.left - mx,
      top: vr.top - my,
      right: vr.right + mx,
      bottom: vr.bottom + my,
    };

    const visibleNodeIds = new Set();
    for (const it of nodeItems) {
      const r = _boundsToClientRect(svg, it.b);
      const on = r && _rectIntersectsClient(r, expanded);
      _setVisible(it.el, !!on);
      if (on) visibleNodeIds.add(it.id);
    }

    // Then show edges only when both endpoints are visible.
    // This avoids costly/fragile edge bbox math and prevents stray edge artifacts.
    for (const e of edgeItems) {
      const on = (visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));
      _setVisible(e.el, on);
    }
  };

  const scheduleUpdate = (_viewBoxIgnored) => {
    if (!enabled) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  };

  const refresh = () => {
    // Some geometry (fonts) settles one frame after insertion; index twice.
    _index();
    try {
      requestAnimationFrame(() => {
        _index();
        scheduleUpdate();
      });
    } catch (_) {
      scheduleUpdate();
    }
  };

  const setEnabled = (on, _viewBoxIgnored) => {
    enabled = !!on;
    if (!enabled) {
      if (raf) {
        try { cancelAnimationFrame(raf); } catch (_) {}
        raf = 0;
      }
      _showAll();
      if (_resizeHandlerInstalled) {
        _resizeHandlerInstalled = false;
        try { window.removeEventListener('resize', _onResize); } catch (_) {}
      }
      return;
    }
    if (!_resizeHandlerInstalled) {
      _resizeHandlerInstalled = true;
      try { window.addEventListener('resize', _onResize, { passive: true }); } catch (_) {}
    }
    refresh();
    scheduleUpdate();
  };

  const dispose = () => {
    enabled = false;
    if (raf) {
      try { cancelAnimationFrame(raf); } catch (_) {}
      raf = 0;
    }
    _showAll();
    if (_resizeHandlerInstalled) {
      _resizeHandlerInstalled = false;
      try { window.removeEventListener('resize', _onResize); } catch (_) {}
    }
    nodeItems.length = 0;
    edgeItems.length = 0;
  };

  // Create initial index, but keep it disabled until explicitly enabled.
  try { _index(); } catch (_) {}

  return {
    setEnabled,
    scheduleUpdate,
    refresh,
    dispose,
  };
}
