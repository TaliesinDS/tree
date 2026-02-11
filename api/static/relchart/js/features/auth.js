/**
 * Auth feature — user badge, logout button, instance switcher.
 *
 * Renders in the top-right of the sidebar brand area.
 */

import * as api from '../api.js';
import { state } from '../state.js';

let _onInstanceSwitch = null;

export function initAuthFeature({ loadNeighborhood } = {}) {
  _onInstanceSwitch = loadNeighborhood;

  // Fetch /auth/me and populate state + UI.
  _loadAuthInfo();
}

async function _loadAuthInfo() {
  try {
    const data = await api.fetchMe();
    state.auth.user = data.user || null;
    state.auth.instance = data.instance || null;
    state.auth.instances = data.instances || [];
    _renderAuthBadge();
    _applyRoleGating();
  } catch (err) {
    // If 401, fetchJson already redirects to /login.
    console.warn('Auth info load failed:', err);
  }
}

function _renderAuthBadge() {
  const container = document.getElementById('authBadge');
  if (!container) return;

  const user = state.auth.user;
  if (!user) {
    container.innerHTML = '';
    return;
  }

  const role = user.role || 'guest';
  const roleLabel = role === 'admin' ? 'admin' : role === 'user' ? 'user' : 'guest';

  let instanceHtml = '';
  if (state.auth.instance) {
    const inst = state.auth.instances.find(i => i.slug === state.auth.instance);
    const label = inst ? inst.display_name : state.auth.instance;
    instanceHtml = `<span class="authInstance" title="Instance: ${state.auth.instance}">${_esc(label)}</span>`;
  }

  let switcherHtml = '';
  if (role === 'admin' && state.auth.instances.length > 1) {
    const options = state.auth.instances.map(i => {
      const sel = i.slug === state.auth.instance ? ' selected' : '';
      return `<option value="${_esc(i.slug)}"${sel}>${_esc(i.display_name)} (${_esc(i.slug)})</option>`;
    }).join('');
    switcherHtml = `<select class="authInstanceSelect miniSelect" title="Switch instance">${options}</select>`;
  }

  container.innerHTML = `
    <span class="authUser" title="${_esc(user.username)} (${roleLabel})">${_esc(user.username)}</span>
    <span class="authRole authRole--${roleLabel}">${roleLabel}</span>
    ${instanceHtml}
    ${switcherHtml}
    <button class="authLogout miniToggle" type="button" title="Log out">Logout</button>
  `;

  // Attach handlers.
  const logoutBtn = container.querySelector('.authLogout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => api.logout());
  }

  const select = container.querySelector('.authInstanceSelect');
  if (select) {
    select.addEventListener('change', async () => {
      const slug = select.value;
      try {
        const activeTab = (() => {
          try {
            const f = window.relchartGetSidebarActiveTab;
            if (typeof f === 'function') return f();
          } catch (_) {}
          return null;
        })();

        await api.switchInstance(slug);
        state.auth.instance = slug;

        // Invalidate all cached data.
        state.peopleLoaded = false;
        state.people = null;
        state.familiesLoaded = false;
        state.families = null;
        state.eventsLoaded = false;
        state.events = null;
        state.eventsTotal = null;
        state.eventsOffset = 0;
        state.placesLoaded = false;
        state.places = null;
        state.payload = null;

        _renderAuthBadge();

        // Reload the graph, then force-refresh the active tab so its list/map data
        // is fetched from the new instance as well.
        const reloadGraph = (typeof _onInstanceSwitch === 'function')
          ? Promise.resolve().then(() => _onInstanceSwitch())
          : Promise.resolve();

        reloadGraph.finally(() => {
          try {
            const setTab = window.relchartSetSidebarActiveTab;
            if (activeTab && typeof setTab === 'function') setTab(activeTab);
          } catch (_) {}
        });
      } catch (err) {
        console.error('Instance switch failed:', err);
        alert('Failed to switch instance: ' + err.message);
      }
    });
  }
}

/**
 * Hide UI sections that guests should not see.
 * - Privacy toggle: guests cannot disable privacy (server-side enforced too).
 * - Import section: guests cannot import data.
 * - Guest management: already hidden via guests.js own check.
 * - User notes tab remains visible so guests can *read* notes.
 */
function _applyRoleGating() {
  const role = state.auth.user?.role;
  const isGuest = role === 'guest';

  // Privacy section.
  const privSec = document.getElementById('optPrivacySection');
  if (privSec) privSec.hidden = isGuest;

  // Import section.
  const importSec = document.getElementById('optImportSection');
  if (importSec) importSec.hidden = isGuest;
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
