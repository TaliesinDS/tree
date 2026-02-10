/** Import state lazily to avoid circular deps. */
let _stateRef = null;
export function _setStateRef(s) { _stateRef = s; }

// ─── CSRF double-submit cookie ───

/** Read the CSRF token from the cookie set by the server. */
export function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)tree_csrf=([^;]+)/);
  return m ? m[1] : '';
}

/** Return headers object with CSRF token for mutating requests. */
function _csrfHeaders(extra = {}) {
  return { 'X-CSRF-Token': getCsrfToken(), ...extra };
}

export async function fetchJson(url) {
  // Inject privacy=off when privacy filter is disabled.
  if (_stateRef && !_stateRef.privacyFilterEnabled) {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('privacy', 'off');
    url = u.toString();
  }
  const res = await fetch(url);
  if (res.status === 401) {
    // Session expired or not authenticated — redirect to login.
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  return await res.json();
}

/** Append privacy=off to a URL string when the filter is disabled. */
export function withPrivacy(url) {
  if (_stateRef && !_stateRef.privacyFilterEnabled) {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('privacy', 'off');
    return u.toString();
  }
  return url;
}

/** Fetch the current authenticated user info from /auth/me. */
export async function fetchMe() {
  return fetchJson('/auth/me');
}

/** Switch to a different instance (admin only). */
export async function switchInstance(slug) {
  const res = await fetch('/auth/switch-instance', {
    method: 'POST',
    headers: _csrfHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Switch failed (${res.status})`);
  }
  return res.json();
}

/** Log out the current user. */
export async function logout() {
  await fetch('/auth/logout');
  window.location.href = '/login';
}

// ─── User Notes ───

export function fetchUserNotes(grampsId) {
  const u = new URL('/user-notes', window.location.origin);
  if (grampsId) u.searchParams.set('gramps_id', grampsId);
  return fetchJson(u.toString());
}

export async function createUserNote(grampsId, body) {
  const res = await fetch('/user-notes', {
    method: 'POST',
    headers: _csrfHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ gramps_id: grampsId, body }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Create note failed (${res.status})`);
  }
  return res.json();
}

export async function updateUserNote(noteId, body) {
  const res = await fetch(`/user-notes/${noteId}`, {
    method: 'PUT',
    headers: _csrfHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Update note failed (${res.status})`);
  }
  return res.json();
}

export async function deleteUserNote(noteId) {
  const res = await fetch(`/user-notes/${noteId}`, {
    method: 'DELETE',
    headers: _csrfHeaders(),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Delete note failed (${res.status})`);
  }
  return res.json();
}

// ─── Instance Members ───

export function fetchGuests(slug) {
  return fetchJson(`/instances/${encodeURIComponent(slug)}/guests`);
}

export async function createGuest(slug, { username, password, display_name }) {
  const res = await fetch(`/instances/${encodeURIComponent(slug)}/guests`, {
    method: 'POST',
    headers: _csrfHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username, password, display_name }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Create guest failed (${res.status})`);
  }
  return res.json();
}

export async function removeGuest(slug, userId) {
  const res = await fetch(`/instances/${encodeURIComponent(slug)}/guests/${userId}`, {
    method: 'DELETE',
    headers: _csrfHeaders(),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Remove guest failed (${res.status})`);
  }
  return res.json();
}

export function neighborhood({ personId, depth, maxNodes }) {
  const u = new URL('/graph/neighborhood', window.location.origin);
  u.searchParams.set('id', String(personId || '').trim());
  u.searchParams.set('depth', String(depth ?? 2));
  u.searchParams.set('max_nodes', String(maxNodes ?? 1000));
  u.searchParams.set('layout', 'family');
  return fetchJson(u.toString());
}

export function familyParents({ familyId, childId }) {
  const u = new URL('/graph/family/parents', window.location.origin);
  u.searchParams.set('family_id', String(familyId || '').trim());
  if (childId) u.searchParams.set('child_id', String(childId).trim());
  return fetchJson(u.toString());
}

export function familyChildren({ familyId, includeSpouses = true }) {
  const u = new URL('/graph/family/children', window.location.origin);
  u.searchParams.set('family_id', String(familyId || '').trim());
  u.searchParams.set('include_spouses', includeSpouses ? 'true' : 'false');
  return fetchJson(u.toString());
}

export function eventDetails({ eventId }) {
  const id = String(eventId || '').trim();
  if (!id) return Promise.reject(new Error('Missing eventId'));
  const u = new URL(`/events/${encodeURIComponent(id)}`, window.location.origin);
  return fetchJson(u.toString());
}
