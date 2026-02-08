export function enableSvgPanZoom(svg, { container, onChange } = {}) {
  const ensureViewBox = () => {
    const vb = svg.viewBox?.baseVal;
    if (vb && Number.isFinite(vb.width) && vb.width > 0 && Number.isFinite(vb.height) && vb.height > 0) return vb;
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 900;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    return svg.viewBox.baseVal;
  };

  const vb0 = ensureViewBox();
  const state = {
    x: vb0.x,
    y: vb0.y,
    w: vb0.width,
    h: vb0.height,
    dragging: false,
    lastX: 0,
    lastY: 0,
    orig: { x: vb0.x, y: vb0.y, w: vb0.width, h: vb0.height },
  };

  const apply = () => {
    svg.setAttribute('viewBox', `${state.x} ${state.y} ${state.w} ${state.h}`);
    try { onChange?.(getViewBox()); } catch (_) {}
  };

  const getViewBox = () => ({ x: state.x, y: state.y, w: state.w, h: state.h });

  const setViewBox = ({ x, y, w, h } = {}) => {
    const nx = Number(x);
    const ny = Number(y);
    const nw = Number(w);
    const nh = Number(h);
    if (![nx, ny, nw, nh].every(Number.isFinite)) return;
    if (nw <= 0 || nh <= 0) return;
    state.x = nx;
    state.y = ny;
    state.w = nw;
    state.h = nh;
    apply();
  };

  const wheel = (e) => {
    e.preventDefault();

    // Compute the cursor point in SVG user units using CTM inverse.
    // This stays correct even with preserveAspectRatio letterboxing.
    let cursorSvg = null;
    try {
      const ctm = svg.getScreenCTM?.();
      if (ctm && typeof ctm.inverse === 'function') {
        const inv = ctm.inverse();
        cursorSvg = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv);
      }
    } catch (_) {
      cursorSvg = null;
    }

    // Fallback: approximate using container proportions.
    if (!cursorSvg) {
      const rect = (container || svg).getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      cursorSvg = {
        x: state.x + state.w * px,
        y: state.y + state.h * py,
      };
    }

    // Cursor-centered zoom with the *old* strength (good feel):
    // one typical wheel notch (~100 deltaY pixels) => exp(±0.12) ≈ 1.13x.
    // Trackpads produce smaller deltaY => proportionally gentler zoom.
    let dy = Number(e.deltaY);
    if (!Number.isFinite(dy)) dy = (e.deltaY > 0 ? 100 : -100);
    // Normalize line/page deltas into pixels-ish.
    if (e.deltaMode === 1) dy *= 16; // lines
    if (e.deltaMode === 2) dy *= 800; // pages (coarse)
    const step = Math.max(-1, Math.min(1, dy / 100));
    const zoom = Math.exp(step * 0.12);

    const newW = state.w * zoom;
    const newH = state.h * zoom;

    // Keep cursorSvg fixed on screen: zoom around that point.
    state.x = cursorSvg.x - (cursorSvg.x - state.x) * zoom;
    state.y = cursorSvg.y - (cursorSvg.y - state.y) * zoom;
    state.w = newW;
    state.h = newH;
    apply();
  };

  // --- Multi-touch (Pointer Events) ---
  // We only implement *two-finger* gestures (pinch-zoom + pan).
  // Single-finger touch is left for tapping/selecting nodes.
  const activeTouches = new Map(); // pointerId -> { x, y }
  const touchGesture = {
    active: false,
    lastMidX: 0,
    lastMidY: 0,
    lastDist: 0,
  };

  const _getTouchPair = () => {
    const pts = Array.from(activeTouches.values());
    if (pts.length < 2) return null;
    return [pts[0], pts[1]];
  };

  const _updateTouchGestureFromPoints = (p0, p1) => {
    const midX = (p0.x + p1.x) / 2;
    const midY = (p0.y + p1.y) / 2;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);
    return { midX, midY, dist };
  };

  const _screenPointToSvg = (clientX, clientY) => {
    try {
      const ctm = svg.getScreenCTM?.();
      if (ctm && typeof ctm.inverse === 'function') {
        const inv = ctm.inverse();
        return new DOMPoint(clientX, clientY).matrixTransform(inv);
      }
    } catch (_) {}
    return null;
  };

  const _clientDeltaToSvgDelta = (dxPx, dyPx) => {
    try {
      const ctm = svg.getScreenCTM?.();
      if (ctm && typeof ctm.inverse === 'function') {
        const inv = ctm.inverse();
        const p0 = new DOMPoint(0, 0).matrixTransform(inv);
        const p1 = new DOMPoint(dxPx, dyPx).matrixTransform(inv);
        const dxSvg = p1.x - p0.x;
        const dySvg = p1.y - p0.y;
        if (Number.isFinite(dxSvg) && Number.isFinite(dySvg)) return { dxSvg, dySvg };
      }
    } catch (_) {}
    return null;
  };

  const _applyTouchTransformStep = ({ midX, midY, dist }) => {
    if (!touchGesture.active) return;
    if (!Number.isFinite(dist) || dist <= 0) return;
    if (!Number.isFinite(touchGesture.lastDist) || touchGesture.lastDist <= 0) return;

    const dxPx = midX - touchGesture.lastMidX;
    const dyPx = midY - touchGesture.lastMidY;

    // Pan (in SVG units) based on midpoint movement.
    const del = _clientDeltaToSvgDelta(dxPx, dyPx);
    if (del) {
      state.x -= del.dxSvg;
      state.y -= del.dySvg;
    } else {
      const rect = (container || svg).getBoundingClientRect();
      state.x -= dxPx * (state.w / rect.width);
      state.y -= dyPx * (state.h / rect.height);
    }

    // Zoom around the midpoint.
    const zoom = touchGesture.lastDist / dist;
    if (Number.isFinite(zoom) && zoom > 0) {
      const midSvg = _screenPointToSvg(midX, midY);
      if (midSvg && Number.isFinite(midSvg.x) && Number.isFinite(midSvg.y)) {
        state.x = midSvg.x - (midSvg.x - state.x) * zoom;
        state.y = midSvg.y - (midSvg.y - state.y) * zoom;
      }
      state.w = state.w * zoom;
      state.h = state.h * zoom;
    }

    apply();

    touchGesture.lastMidX = midX;
    touchGesture.lastMidY = midY;
    touchGesture.lastDist = dist;
  };

  const down = (e) => {
    // Touch: only handle 2-finger gestures. Do not intercept single-finger taps.
    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Start gesture once we have two active touches.
      if (activeTouches.size >= 2) {
        const pair = _getTouchPair();
        if (pair) {
          e.preventDefault();
          state.dragging = false;
          (container || svg).style.cursor = 'grabbing';
          document.body.style.userSelect = 'none';

          // Capture all active touch pointers.
          for (const pid of activeTouches.keys()) {
            try { (container || svg).setPointerCapture(pid); } catch (_) {}
          }

          const next = _updateTouchGestureFromPoints(pair[0], pair[1]);
          touchGesture.active = true;
          touchGesture.lastMidX = next.midX;
          touchGesture.lastMidY = next.midY;
          touchGesture.lastDist = next.dist;
        }
      }
      return;
    }

    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('g.node')) return;
    e.preventDefault();
    state.dragging = true;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    (container || svg).style.cursor = 'grabbing';
    try { (container || svg).setPointerCapture(e.pointerId); } catch (_) {}
    document.body.style.userSelect = 'none';
  };

  const move = (e) => {
    // Touch gesture: pinch + pan.
    if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touchGesture.active && activeTouches.size >= 2) {
        e.preventDefault();
        const pair = _getTouchPair();
        if (!pair) return;
        const next = _updateTouchGestureFromPoints(pair[0], pair[1]);
        _applyTouchTransformStep(next);
      }
      return;
    }

    if (!state.dragging) return;
    e.preventDefault();

    const dxPx = e.clientX - state.lastX;
    const dyPx = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;

    // Convert pixel delta to SVG user-unit delta as a *vector*.
    // Using vector transform avoids feedback lag/flicker because the viewBox
    // translation changes the point mapping but does not affect vectors.
    try {
      const ctm = svg.getScreenCTM?.();
      if (ctm && typeof ctm.inverse === 'function') {
        const inv = ctm.inverse();
        const p0 = new DOMPoint(0, 0).matrixTransform(inv);
        const p1 = new DOMPoint(dxPx, dyPx).matrixTransform(inv);
        const dxSvg = p1.x - p0.x;
        const dySvg = p1.y - p0.y;
        if (Number.isFinite(dxSvg) && Number.isFinite(dySvg)) {
          state.x -= dxSvg;
          state.y -= dySvg;
          apply();
          return;
        }
      }
    } catch (_) {}

    // Fallback: approximate using container proportions.
    const rect = (container || svg).getBoundingClientRect();
    state.x -= dxPx * (state.w / rect.width);
    state.y -= dyPx * (state.h / rect.height);
    apply();
  };

  const up = (e) => {
    // Touch end.
    if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
      activeTouches.delete(e.pointerId);

      if (touchGesture.active && activeTouches.size < 2) {
        e.preventDefault();
        touchGesture.active = false;
        touchGesture.lastMidX = 0;
        touchGesture.lastMidY = 0;
        touchGesture.lastDist = 0;
        (container || svg).style.cursor = 'grab';
        document.body.style.userSelect = '';
        try { (container || svg).releasePointerCapture(e.pointerId); } catch (_) {}
      }
      return;
    }

    if (!state.dragging) return;
    e.preventDefault();
    state.dragging = false;
    (container || svg).style.cursor = 'grab';
    document.body.style.userSelect = '';
    try { (container || svg).releasePointerCapture(e.pointerId); } catch (_) {}
  };

  const target = container || svg;
  target.style.cursor = 'grab';
  // Allow pinch/pan to be handled by our Pointer Events handlers.
  // (Otherwise mobile browsers may intercept for page scroll/zoom.)
  try { if (!target.style.touchAction) target.style.touchAction = 'none'; } catch (_) {}
  target.addEventListener('wheel', wheel, { passive: false });
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);

  return {
    reset: () => {
      state.x = state.orig.x;
      state.y = state.orig.y;
      state.w = state.orig.w;
      state.h = state.orig.h;
      apply();
    },
    getViewBox,
    setViewBox,
  };
}
