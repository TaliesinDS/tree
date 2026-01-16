export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  return await res.json();
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
