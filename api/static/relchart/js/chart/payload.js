export function mergeGraphPayload(base, delta) {
  const out = {
    ...(base || {}),
    nodes: [],
    edges: [],
  };

  const nodesById = new Map();
  for (const n of (base?.nodes || [])) {
    if (n?.id) nodesById.set(String(n.id), n);
  }
  for (const n of (delta?.nodes || [])) {
    if (n?.id) nodesById.set(String(n.id), n);
  }
  out.nodes = [...nodesById.values()];

  const edgeKey = (e) => {
    const from = String(e?.from || '');
    const to = String(e?.to || '');
    const type = String(e?.type || '');
    const role = String(e?.role || '');
    return `${from}|${to}|${type}|${role}`;
  };
  const edgesByKey = new Map();
  for (const e of (base?.edges || [])) edgesByKey.set(edgeKey(e), e);
  for (const e of (delta?.edges || [])) edgesByKey.set(edgeKey(e), e);
  out.edges = [...edgesByKey.values()];

  return out;
}

export function computeHiddenParentFamiliesByPersonId(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];

  const personIds = new Set(nodes.filter(n => n?.type === 'person').map(n => String(n.id)));
  const familyNodes = nodes.filter(n => n?.type === 'family');
  const familyIds = new Set(familyNodes.map(n => String(n.id)));
  if (!familyIds.size) return new Map();

  const parentsTotalByFamily = new Map();
  for (const n of familyNodes) {
    const fid = String(n?.id || '');
    if (!fid) continue;
    const pt = Number(n?.parents_total);
    if (Number.isFinite(pt) && pt >= 0) parentsTotalByFamily.set(fid, pt);
  }

  const hasAnyParentEdge = new Set();
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    const fid = String(e.to || '');
    const pid = String(e.from || '');
    if (fid && familyIds.has(fid) && pid && personIds.has(pid)) hasAnyParentEdge.add(fid);
  }

  const out = new Map();
  for (const e of edges) {
    if (e?.type !== 'child') continue;
    const fid = String(e.from || '');
    const cid = String(e.to || '');
    if (!fid || !cid) continue;
    if (!familyIds.has(fid)) continue;
    if (!personIds.has(cid)) continue;

    const parentsTotal = parentsTotalByFamily.has(fid) ? parentsTotalByFamily.get(fid) : null;
    if (parentsTotal !== null && Number.isFinite(parentsTotal) && parentsTotal <= 0) continue;
    if (hasAnyParentEdge.has(fid)) continue;

    const arr = out.get(cid) || [];
    arr.push(fid);
    out.set(cid, arr);
  }
  return out;
}

export function computeHiddenChildFamiliesByPersonId(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];

  const personIds = new Set(nodes.filter(n => n?.type === 'person').map(n => String(n.id)));
  const familyNodes = nodes.filter(n => n?.type === 'family');
  const familyIds = new Set(familyNodes.map(n => String(n.id)));
  if (!familyIds.size) return new Map();

  const familyHasMoreChildren = new Set(familyNodes.filter(n => !!n?.has_more_children).map(n => String(n.id)));

  const childrenTotalByFamily = new Map();
  for (const n of familyNodes) {
    const fid = String(n?.id || '');
    if (!fid) continue;
    const ct = Number(n?.children_total);
    if (Number.isFinite(ct) && ct >= 0) childrenTotalByFamily.set(fid, ct);
  }

  const childEdgeCountByFamily = new Map();
  for (const e of edges) {
    if (e?.type !== 'child') continue;
    const fid = String(e.from || '');
    const cid = String(e.to || '');
    if (!fid || !familyIds.has(fid)) continue;
    if (!cid || !personIds.has(cid)) continue;
    childEdgeCountByFamily.set(fid, (childEdgeCountByFamily.get(fid) || 0) + 1);
  }

  const out = new Map();
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    const pid = String(e.from || '');
    const fid = String(e.to || '');
    if (!pid || !fid) continue;
    if (!familyIds.has(fid)) continue;

    const childEdgeCount = childEdgeCountByFamily.get(fid) || 0;
    const childrenTotal = childrenTotalByFamily.has(fid) ? childrenTotalByFamily.get(fid) : null;
    const needsExpand = (childrenTotal !== null && Number.isFinite(childrenTotal))
      ? (childrenTotal > childEdgeCount)
      : (familyHasMoreChildren.has(fid) || childEdgeCount === 0);
    if (!needsExpand) continue;

    const arr = out.get(pid) || [];
    arr.push(fid);
    out.set(pid, arr);
  }
  return out;
}
