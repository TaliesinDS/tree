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
    dragging: false,   // mouse/pen drag
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

  // ── Shared helpers ──

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

  const _panByPixelDelta = (dxPx, dyPx) => {
    const del = _clientDeltaToSvgDelta(dxPx, dyPx);
    if (del) {
      state.x -= del.dxSvg;
      state.y -= del.dySvg;
    } else {
      const rect = (container || svg).getBoundingClientRect();
      state.x -= dxPx * (state.w / rect.width);
      state.y -= dyPx * (state.h / rect.height);
    }
    apply();
  };

  const _zoomAroundScreenPoint = (clientX, clientY, zoomFactor) => {
    const midSvg = _screenPointToSvg(clientX, clientY);
    if (midSvg && Number.isFinite(midSvg.x) && Number.isFinite(midSvg.y)) {
      state.x = midSvg.x - (midSvg.x - state.x) * zoomFactor;
      state.y = midSvg.y - (midSvg.y - state.y) * zoomFactor;
    }
    state.w *= zoomFactor;
    state.h *= zoomFactor;
    apply();
  };

  const _isNode = (el) => !!(el && el.closest && el.closest('g.node'));

  // ── Mouse / Pen (Pointer Events — touch is skipped, see Touch Events below) ──

  const wheel = (e) => {
    e.preventDefault();

    let cursorSvg = _screenPointToSvg(e.clientX, e.clientY);
    if (!cursorSvg) {
      const rect = (container || svg).getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      cursorSvg = { x: state.x + state.w * px, y: state.y + state.h * py };
    }

    let dy = Number(e.deltaY);
    if (!Number.isFinite(dy)) dy = (e.deltaY > 0 ? 100 : -100);
    if (e.deltaMode === 1) dy *= 16;
    if (e.deltaMode === 2) dy *= 800;
    const step = Math.max(-1, Math.min(1, dy / 100));
    const zoom = Math.exp(step * 0.12);

    state.x = cursorSvg.x - (cursorSvg.x - state.x) * zoom;
    state.y = cursorSvg.y - (cursorSvg.y - state.y) * zoom;
    state.w *= zoom;
    state.h *= zoom;
    apply();
  };

  const down = (e) => {
    if (e.button !== 0) return;
    if (_isNode(e.target)) return;
    e.preventDefault();
    state.dragging = true;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    (container || svg).style.cursor = 'grabbing';
    // For mouse/pen use explicit capture; for touch the browser already
    // provides implicit capture when touch-action:none is set.
    if (e.pointerType !== 'touch') {
      try { (container || svg).setPointerCapture(e.pointerId); } catch (_) {}
    }
    document.body.style.userSelect = 'none';
  };

  const move = (e) => {
    if (!state.dragging) return;
    e.preventDefault();

    const dxPx = e.clientX - state.lastX;
    const dyPx = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    _panByPixelDelta(dxPx, dyPx);
  };

  const up = (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    state.dragging = false;
    (container || svg).style.cursor = 'grab';
    document.body.style.userSelect = '';
    if (e.pointerType !== 'touch') {
      try { (container || svg).releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };

  // ── Touch (Touch Events API — reliable across all mobile browsers) ──

  const touch = {
    pinching: false,
    lastMidX: 0,
    lastMidY: 0,
    lastDist: 0,
  };

  const _twoFingerMetrics = (touches) => {
    if (!touches || touches.length < 2) return null;
    const t0 = touches[0];
    const t1 = touches[1];
    const midX = (t0.clientX + t1.clientX) / 2;
    const midY = (t0.clientY + t1.clientY) / 2;
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    return { midX, midY, dist };
  };

  const touchStart = (e) => {
    if (!e || !e.touches) return;

    // Single-finger pan is handled by Pointer Events (implicit capture).
    // Touch Events only handle 2-finger pinch+pan.
    if (e.touches.length < 2) return;

    if (e.touches.length >= 2) {
      // Cancel any in-progress single-finger pointer drag.
      if (state.dragging) {
        state.dragging = false;
        (container || svg).style.cursor = 'grab';
        document.body.style.userSelect = '';
      }
      const m = _twoFingerMetrics(e.touches);
      if (!m || !Number.isFinite(m.dist) || m.dist <= 0) return;
      touch.dragging = false;
      touch.pinching = true;
      touch.lastMidX = m.midX;
      touch.lastMidY = m.midY;
      touch.lastDist = m.dist;
      (container || svg).style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    }
  };

  const touchMove = (e) => {
    if (!e || !e.touches) return;

    // Two-finger pinch + pan.
    if (touch.pinching && e.touches.length >= 2) {
      const m = _twoFingerMetrics(e.touches);
      if (!m || !Number.isFinite(m.dist) || m.dist <= 0) return;
      if (!Number.isFinite(touch.lastDist) || touch.lastDist <= 0) return;
      e.preventDefault();

      // Pan based on midpoint movement.
      _panByPixelDelta(m.midX - touch.lastMidX, m.midY - touch.lastMidY);

      // Zoom around midpoint.
      const zoom = touch.lastDist / m.dist;
      if (Number.isFinite(zoom) && zoom > 0) {
        _zoomAroundScreenPoint(m.midX, m.midY, zoom);
      }

      touch.lastMidX = m.midX;
      touch.lastMidY = m.midY;
      touch.lastDist = m.dist;
      return;
    }

  };

  const touchEnd = (e) => {
    if (!e) return;
    const remaining = e.touches;

    if (!remaining || remaining.length === 0) {
      if (touch.pinching) e.preventDefault();
      touch.pinching = false;
      touch.lastDist = 0;
      (container || svg).style.cursor = 'grab';
      document.body.style.userSelect = '';
      return;
    }

    // Transition: pinch ended, one finger remains.
    // Let pointer events handle any continued single-finger drag.
    if (touch.pinching && remaining.length === 1) {
      touch.pinching = false;
      e.preventDefault();
    }
  };

  // ── Attach listeners ──

  const target = container || svg;
  target.style.cursor = 'grab';
  // Prevent browser from intercepting touch for page scroll/zoom.
  target.style.touchAction = 'none';
  svg.style.touchAction = 'none';

  // Pointer Events (mouse + pen only; touch pointerType is skipped).
  target.addEventListener('wheel', wheel, { passive: false });
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);

  // Touch Events (all touch gestures: 1-finger pan, 2-finger pinch+pan).
  target.addEventListener('touchstart', touchStart, { passive: false });
  target.addEventListener('touchmove', touchMove, { passive: false });
  target.addEventListener('touchend', touchEnd, { passive: false });
  target.addEventListener('touchcancel', touchEnd, { passive: false });

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
