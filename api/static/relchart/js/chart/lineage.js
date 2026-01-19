/**
 * lineage.js - Ancestor/descendant line tracing utilities
 * 
 * These functions trace lineages through a graph payload for use cases like:
 * - Highlighting direct ancestor lines (paternal/maternal)
 * - Finding paths between two people
 * - Showing "line of descent" visualizations
 * 
 * All functions work with the graph payload format returned by the API:
 * { nodes: [...], edges: [...] }
 * 
 * Node types: 'person', 'family'
 * Edge types: 'parent' (person→family), 'child' (family→person)
 * 
 * USAGE EXAMPLES:
 * 
 * 1. Get direct paternal line (father's father's father...):
 *    const line = traceAncestorLine(payload, 'I0001', { preferGender: 'M' });
 *    // Returns: { personIds: [...], familyIds: [...], persons: [...] }
 * 
 * 2. Get direct maternal line:
 *    const line = traceAncestorLine(payload, 'I0001', { preferGender: 'F' });
 * 
 * 3. Get any ancestor line (prefers father, falls back to mother):
 *    const line = traceAncestorLine(payload, 'I0001');
 * 
 * 4. Use the result for edge highlighting:
 *    const { personIds, familyIds } = traceAncestorLine(payload, rootId);
 *    // Then in render.js, highlight edges where both endpoints are in the set
 */

/**
 * Build lookup maps from a graph payload.
 * @param {Object} payload - { nodes: [...], edges: [...] }
 * @returns {Object} - { peopleById, familiesById, personByGrampsId }
 */
export function buildPayloadMaps(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  
  const peopleById = new Map(
    nodes.filter(n => n?.type === 'person' && n?.id).map(n => [String(n.id), n])
  );
  const familiesById = new Map(
    nodes.filter(n => n?.type === 'family' && n?.id).map(n => [String(n.id), n])
  );
  const personByGrampsId = new Map();
  for (const [id, p] of peopleById.entries()) {
    const gid = String(p?.gramps_id || '').trim();
    if (gid) personByGrampsId.set(gid, id);
  }
  
  return { peopleById, familiesById, personByGrampsId };
}

/**
 * Resolve a person ID (Gramps ID or internal API ID) to internal API ID.
 * @param {string} idOrGrampsId - Either "I0001" (Gramps) or "_f37b66a39d..." (internal)
 * @param {Map} peopleById - Map of internal ID → person node
 * @param {Map} personByGrampsId - Map of Gramps ID → internal ID
 * @returns {string|null} - Internal API ID or null if not found
 */
export function resolvePersonId(idOrGrampsId, peopleById, personByGrampsId) {
  const raw = String(idOrGrampsId || '').trim();
  if (!raw) return null;
  if (peopleById.has(raw)) return raw;
  return personByGrampsId.get(raw) || null;
}

/**
 * Build edge lookup maps for parent/child traversal.
 * @param {Array} edges - Array of edge objects from payload
 * @returns {Object} - { childToParentFamilies, familyToParents, familyToChildren }
 */
export function buildEdgeMaps(edges) {
  const edgeList = Array.isArray(edges) ? edges : [];
  
  // child person ID → [family IDs] (families this person is a child in)
  const childToParentFamilies = new Map();
  // family ID → [child person IDs]
  const familyToChildren = new Map();
  // family ID → { father: personId, mother: personId }
  const familyToParents = new Map();
  
  for (const e of edgeList) {
    const type = String(e?.type || '').trim();
    
    if (type === 'child') {
      // child edge: family → person
      const fid = String(e.from || '').trim();
      const cid = String(e.to || '').trim();
      if (!fid || !cid) continue;
      
      // Track child's parent families
      const fams = childToParentFamilies.get(cid) || [];
      fams.push(fid);
      childToParentFamilies.set(cid, fams);
      
      // Track family's children
      const kids = familyToChildren.get(fid) || [];
      kids.push(cid);
      familyToChildren.set(fid, kids);
    }
    
    if (type === 'parent') {
      // parent edge: person → family (with role: 'father' or 'mother')
      const pid = String(e.from || '').trim();
      const fid = String(e.to || '').trim();
      if (!pid || !fid) continue;
      
      const cur = familyToParents.get(fid) || { father: null, mother: null };
      if (e.role === 'father') cur.father = pid;
      if (e.role === 'mother') cur.mother = pid;
      familyToParents.set(fid, cur);
    }
  }
  
  return { childToParentFamilies, familyToParents, familyToChildren };
}

/**
 * Trace a direct ancestor line from a root person upward.
 * 
 * @param {Object} payload - Graph payload { nodes: [...], edges: [...] }
 * @param {string} rootPersonId - Starting person (Gramps ID or internal API ID)
 * @param {Object} options
 * @param {string} options.preferGender - 'M' for paternal line, 'F' for maternal line, null for either (prefers father)
 * @param {number} options.maxDepth - Maximum generations to trace (default: 100)
 * @returns {Object} - { personIds: Set, familyIds: Set, personOrder: Array, persons: Array }
 *   - personIds: Set of internal API IDs of all persons in the line
 *   - familyIds: Set of internal API IDs of all families connecting the line
 *   - personOrder: Array of person IDs in order [root, parent, grandparent, ...]
 *   - persons: Array of person node objects in order
 */
export function traceAncestorLine(payload, rootPersonId, { preferGender = null, maxDepth = 100 } = {}) {
  const { peopleById, personByGrampsId } = buildPayloadMaps(payload);
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];
  const { childToParentFamilies, familyToParents } = buildEdgeMaps(edges);
  
  const personIds = new Set();
  const familyIds = new Set();
  const personOrder = [];
  
  // Resolve starting person
  const rootIdInternal = resolvePersonId(rootPersonId, peopleById, personByGrampsId);
  if (!rootIdInternal) {
    return { personIds, familyIds, personOrder, persons: [] };
  }
  
  // Trace upward
  let current = rootIdInternal;
  personIds.add(current);
  personOrder.push(current);
  const visited = new Set([current]);
  let depth = 0;
  
  while (current && depth < maxDepth) {
    const parentFams = childToParentFamilies.get(current) || [];
    let nextPerson = null;
    
    for (const fid of parentFams) {
      const parents = familyToParents.get(fid);
      if (!parents) continue;
      
      familyIds.add(fid);
      
      // Select which parent to follow based on preference
      let chosen = null;
      if (preferGender === 'M') {
        // Paternal line: prefer father only
        chosen = parents.father;
      } else if (preferGender === 'F') {
        // Maternal line: prefer mother only
        chosen = parents.mother;
      } else {
        // Default: prefer father, fall back to mother (primogeniture)
        chosen = parents.father || parents.mother;
      }
      
      if (chosen && !visited.has(chosen)) {
        nextPerson = chosen;
        visited.add(nextPerson);
        personIds.add(nextPerson);
        personOrder.push(nextPerson);
        break;
      }
    }
    
    current = nextPerson;
    depth++;
  }
  
  // Build persons array
  const persons = personOrder.map(id => peopleById.get(id)).filter(Boolean);
  
  return { personIds, familyIds, personOrder, persons };
}

/**
 * Trace a direct descendant line from a root person downward.
 * Note: This follows first-child heuristics since trees branch downward.
 * 
 * @param {Object} payload - Graph payload
 * @param {string} rootPersonId - Starting ancestor
 * @param {Object} options
 * @param {number} options.maxDepth - Maximum generations to trace
 * @returns {Object} - Same structure as traceAncestorLine
 */
export function traceDescendantLine(payload, rootPersonId, { maxDepth = 100 } = {}) {
  const { peopleById, personByGrampsId } = buildPayloadMaps(payload);
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];
  const { familyToParents, familyToChildren } = buildEdgeMaps(edges);
  
  const personIds = new Set();
  const familyIds = new Set();
  const personOrder = [];
  
  const rootIdInternal = resolvePersonId(rootPersonId, peopleById, personByGrampsId);
  if (!rootIdInternal) {
    return { personIds, familyIds, personOrder, persons: [] };
  }
  
  // Build person → families-as-parent map
  const personToSpouseFamilies = new Map();
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    const pid = String(e.from || '').trim();
    const fid = String(e.to || '').trim();
    if (!pid || !fid) continue;
    const fams = personToSpouseFamilies.get(pid) || [];
    fams.push(fid);
    personToSpouseFamilies.set(pid, fams);
  }
  
  // Trace downward (first child in first family)
  let current = rootIdInternal;
  personIds.add(current);
  personOrder.push(current);
  const visited = new Set([current]);
  let depth = 0;
  
  while (current && depth < maxDepth) {
    const spouseFams = personToSpouseFamilies.get(current) || [];
    let nextPerson = null;
    
    for (const fid of spouseFams) {
      const children = familyToChildren.get(fid) || [];
      familyIds.add(fid);
      
      for (const childId of children) {
        if (!visited.has(childId)) {
          nextPerson = childId;
          visited.add(nextPerson);
          personIds.add(nextPerson);
          personOrder.push(nextPerson);
          break;
        }
      }
      if (nextPerson) break;
    }
    
    current = nextPerson;
    depth++;
  }
  
  const persons = personOrder.map(id => peopleById.get(id)).filter(Boolean);
  return { personIds, familyIds, personOrder, persons };
}

/**
 * Get all edges that connect persons/families in a given set.
 * Useful for highlighting edges along a traced line.
 * 
 * @param {Object} payload - Graph payload
 * @param {Set} personIds - Set of person IDs in the line
 * @param {Set} familyIds - Set of family IDs in the line
 * @returns {Array} - Array of edge objects that connect members of the line
 */
export function getEdgesForLine(payload, personIds, familyIds) {
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];
  const result = [];
  
  for (const e of edges) {
    const from = String(e?.from || '').trim();
    const to = String(e?.to || '').trim();
    if (!from || !to) continue;
    
    if (e.type === 'parent') {
      // person → family
      if (personIds.has(from) && familyIds.has(to)) {
        result.push(e);
      }
    } else if (e.type === 'child') {
      // family → person
      if (familyIds.has(from) && personIds.has(to)) {
        result.push(e);
      }
    }
  }
  
  return result;
}
