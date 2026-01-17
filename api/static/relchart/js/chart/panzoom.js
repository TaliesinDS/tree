export function enableSvgPanZoom(svg, { container } = {}) {
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
    const rect = (container || svg).getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const zoom = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.12);
    const newW = state.w * zoom;
    const newH = state.h * zoom;
    state.x = state.x + (state.w - newW) * px;
    state.y = state.y + (state.h - newH) * py;
    state.w = newW;
    state.h = newH;
    apply();
  };

  const down = (e) => {
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
    if (!state.dragging) return;
    e.preventDefault();
    const rect = (container || svg).getBoundingClientRect();
    const dxPx = e.clientX - state.lastX;
    const dyPx = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    state.x -= dxPx * (state.w / rect.width);
    state.y -= dyPx * (state.h / rect.height);
    apply();
  };

  const up = (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    state.dragging = false;
    (container || svg).style.cursor = 'grab';
    document.body.style.userSelect = '';
    try { (container || svg).releasePointerCapture(e.pointerId); } catch (_) {}
  };

  const target = container || svg;
  target.style.cursor = 'grab';
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
