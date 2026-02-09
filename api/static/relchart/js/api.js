/** Import state lazily to avoid circular deps. */
let _stateRef = null;
export function _setStateRef(s) { _stateRef = s; }

export async function fetchJson(url) {
  // Inject privacy=off when privacy filter is disabled.
  if (_stateRef && !_stateRef.privacyFilterEnabled) {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('privacy', 'off');
    url = u.toString();
  }
  const res = await fetch(url);
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
