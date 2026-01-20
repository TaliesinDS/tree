import { setSidebarActiveTab } from './tabs.js';

let _installed = false;

export function initKeybindsFeature() {
  if (_installed) return;
  _installed = true;

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'g') setSidebarActiveTab('graph');
    if (k === 'p') setSidebarActiveTab('people');
    if (k === 'f') setSidebarActiveTab('families');
    if (k === 'e') setSidebarActiveTab('events');
    if (k === 'm') setSidebarActiveTab('map');
  });
}
