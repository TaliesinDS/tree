/**
 * Guest management feature — renders inside the Options panel.
 *
 * - Lists current instance members (guests/users)
 * - Allows user/admin to create new guest accounts
 * - Allows user/admin to remove guest accounts
 * - Only visible when user.role is 'user' or 'admin'
 */

import * as api from '../api.js';
import { state } from '../state.js';

let _container = null;

export function initGuestsFeature() {
  _container = document.getElementById('guestManagement');
  if (!_container) return;

  // Defer rendering until auth info is loaded.
  // The auth feature populates state.auth — wait a beat then check.
  setTimeout(_maybeRender, 500);
}

function _maybeRender() {
  if (!_container) return;
  const user = state.auth?.user;
  if (!user || user.role === 'guest') {
    _container.hidden = true;
    return;
  }
  _container.hidden = false;
  _loadGuests();
}

async function _loadGuests() {
  const slug = state.auth?.instance;
  if (!slug) {
    _container.innerHTML = '<div class="optHint">No instance selected.</div>';
    return;
  }

  _container.innerHTML = '<div class="optHint">Loading members…</div>';

  try {
    const data = await api.fetchGuests(slug);
    const members = Array.isArray(data?.members) ? data.members : [];
    _render(members, slug);
  } catch (err) {
    _container.innerHTML = `<div class="optHint" style="color:var(--danger)">Failed: ${_esc(err.message)}</div>`;
  }
}

function _render(members, slug) {
  const user = state.auth?.user;

  let html = '<div class="optionsSectionTitle">Members</div>';

  if (members.length === 0) {
    html += '<div class="optHint">No members yet.</div>';
  } else {
    html += '<ul class="guestList">';
    for (const m of members) {
      const isSelf = user && m.user_id === user.id;
      const removeBtn = !isSelf
        ? `<button type="button" class="guestRemoveBtn" data-remove-uid="${m.user_id}" title="Remove ${_esc(m.username)}">×</button>`
        : '<span style="font-size:10px;color:var(--muted)">(you)</span>';
      html += `<li class="guestItem">
        <span>${_esc(m.display_name || m.username)} <span style="color:var(--muted);font-size:10px">(${_esc(m.role)})</span></span>
        ${removeBtn}
      </li>`;
    }
    html += '</ul>';
  }

  // Add guest form.
  html += `
    <div class="optionsSectionTitle" style="margin-top:8px">Add guest</div>
    <div class="guestAddRow">
      <input data-guest-field="username" placeholder="Username" autocomplete="off" />
      <input data-guest-field="password" type="password" placeholder="Password" autocomplete="new-password" />
      <button type="button" class="miniToggle" data-action="add-guest">Add</button>
    </div>
    <div data-guest-error class="optHint" style="color:var(--danger);min-height:1em;margin-top:2px"></div>
  `;

  _container.innerHTML = html;

  // Wire remove buttons.
  for (const btn of _container.querySelectorAll('[data-remove-uid]')) {
    btn.addEventListener('click', async () => {
      const uid = Number(btn.dataset.removeUid);
      if (!confirm('Remove this member?')) return;
      btn.disabled = true;
      try {
        await api.removeGuest(slug, uid);
        await _loadGuests();
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    });
  }

  // Wire add button.
  const addBtn = _container.querySelector('[data-action="add-guest"]');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const usernameInput = _container.querySelector('[data-guest-field="username"]');
      const passwordInput = _container.querySelector('[data-guest-field="password"]');
      const errorEl = _container.querySelector('[data-guest-error]');

      const username = (usernameInput?.value || '').trim();
      const password = (passwordInput?.value || '');

      if (!username || !password) {
        if (errorEl) errorEl.textContent = 'Username and password are required.';
        return;
      }
      if (errorEl) errorEl.textContent = '';
      addBtn.disabled = true;

      try {
        await api.createGuest(slug, { username, password });
        await _loadGuests();
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message;
      } finally {
        addBtn.disabled = false;
      }
    });
  }
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
