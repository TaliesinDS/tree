// Topbar popover portaling
//
// The topbar uses `position: sticky` + a z-index, which forms a stacking context.
// That means dropdown panels inside it cannot rise above other fixed overlays
// (like the person detail panel) even if they have a higher z-index.
//
// Solution: when a <details> menu opens, temporarily move its panel element to
// document.body and position it using fixed coordinates.

const _portalState = {
  byDetails: new Map(),
};

function _getPortaledPanel(detailsEl) {
  return _portalState.byDetails.get(detailsEl) || null;
}

export function _isInsideDetailsOrPortal(detailsEl, target) {
  const t = target;
  if (!t) return false;
  try {
    if (detailsEl?.contains?.(t)) return true;
  } catch (_) {}
  try {
    const p = _getPortaledPanel(detailsEl);
    if (p && p.contains && p.contains(t)) return true;
  } catch (_) {}
  return false;
}

function _positionPortaledPanel(detailsEl) {
  const info = _portalState.byDetails.get(detailsEl);
  if (!info) return;
  const { panel, align } = info;
  if (!panel) return;

  const r = detailsEl?.querySelector?.('summary')?.getBoundingClientRect?.()
    || detailsEl?.getBoundingClientRect?.();
  if (!r) return;

  // Ensure it has a measurable size.
  const panelW = panel.offsetWidth || 260;
  const panelH = panel.offsetHeight || 180;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;

  let left = r.left;
  if (align === 'right') left = r.right - panelW;
  left = Math.max(8, Math.min(left, vw - panelW - 8));

  let top = r.bottom + 8;
  top = Math.max(8, Math.min(top, vh - panelH - 8));

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

export function _portalDetailsPanel(detailsEl, panelSelector, { align = 'left' } = {}) {
  if (!detailsEl) return;
  const existing = _portalState.byDetails.get(detailsEl);
  if (existing?.panel) {
    _positionPortaledPanel(detailsEl);
    return;
  }

  const panel = detailsEl.querySelector(panelSelector);
  if (!panel) return;

  const homeParent = panel.parentElement;
  const homeNextSibling = panel.nextSibling;
  const homeStyle = panel.getAttribute('style');

  // Prevent "click outside" handlers from closing the popover while interacting
  // with the portaled panel (checkboxes, number spinners, selects).
  const stopPropagationCapture = (e) => {
    try { e.stopPropagation(); } catch (_) {}
  };
  try { panel.addEventListener('pointerdown', stopPropagationCapture, true); } catch (_) {}
  try { panel.addEventListener('click', stopPropagationCapture, true); } catch (_) {}

  _portalState.byDetails.set(detailsEl, {
    panel,
    homeParent,
    homeNextSibling,
    homeStyle,
    align,
    stopPropagationCapture,
  });

  try { document.body.appendChild(panel); } catch (_) {}
  try {
    panel.style.position = 'fixed';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.margin = '0';
  } catch (_) {}

  _positionPortaledPanel(detailsEl);
}

export function _unportalDetailsPanel(detailsEl) {
  const info = _portalState.byDetails.get(detailsEl);
  if (!info) return;
  _portalState.byDetails.delete(detailsEl);

  const { panel, homeParent, homeNextSibling, homeStyle, stopPropagationCapture } = info;
  if (!panel) return;

  try { if (stopPropagationCapture) panel.removeEventListener('pointerdown', stopPropagationCapture, true); } catch (_) {}
  try { if (stopPropagationCapture) panel.removeEventListener('click', stopPropagationCapture, true); } catch (_) {}

  try {
    if (homeParent) {
      if (homeNextSibling && homeNextSibling.parentNode === homeParent) {
        homeParent.insertBefore(panel, homeNextSibling);
      } else {
        homeParent.appendChild(panel);
      }
    }
  } catch (_) {}

  try {
    if (homeStyle === null || homeStyle === undefined) panel.removeAttribute('style');
    else panel.setAttribute('style', homeStyle);
  } catch (_) {}
}

window.addEventListener('resize', () => {
  for (const detailsEl of _portalState.byDetails.keys()) {
    try { _positionPortaledPanel(detailsEl); } catch (_) {}
  }
});
