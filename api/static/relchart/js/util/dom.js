export function _cssEscape(s) {
  const v = String(s ?? '');
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
  } catch (_) {}
  return v.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}
