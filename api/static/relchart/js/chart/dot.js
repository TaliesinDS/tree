function esc(s) {
  return String(s ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function dotId(id) {
  return `"${esc(id)}"`;
}

function htmlEsc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const PERSON_CARD_WIDTH_IN = 1.60;
const PERSON_CARD_HEIGHT_IN = 1.10;

function wrapTextLines(text, { maxCharsPerLine = 24, maxLines = 2 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [''];

  const words = raw.split(/\s+/g).filter(Boolean);
  if (words.length <= 1) {
    const single = raw;
    if (single.length <= maxCharsPerLine) return [single];
    return [single.slice(0, Math.max(1, maxCharsPerLine - 1)) + '…'];
  }

  const lines = [];
  let current = '';

  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length <= maxCharsPerLine || !current) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = w;
    if (lines.length >= maxLines - 1) break;
  }

  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length > maxLines) lines.length = maxLines;

  if (lines.length === maxLines) {
    const joinedWords = words.join(' ');
    const already = lines.join(' ');
    if (already.length < joinedWords.length) {
      const lastIdx = lines.length - 1;
      const last = lines[lastIdx];
      if (last.length > maxCharsPerLine) {
        lines[lastIdx] = last.slice(0, Math.max(1, maxCharsPerLine - 1)) + '…';
      } else if (!last.endsWith('…')) {
        lines[lastIdx] = (last.length >= maxCharsPerLine)
          ? last.slice(0, Math.max(1, maxCharsPerLine - 1)) + '…'
          : (last + '…');
      }
    }
  }

  return lines;
}

function formatNameLines(p) {
  const given = (p?.given_name || '').trim();
  const surname = (p?.surname || '').trim();
  if (given || surname) return { given: given || '?', surname: surname || '' };
  const dn = (p?.display_name || '').trim();
  if (!dn) return { given: '?', surname: '' };
  if (dn === 'Private') return { given: 'Private', surname: '' };
  const parts = dn.split(/\s+/g);
  if (parts.length <= 1) return { given: dn, surname: '' };
  return { given: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
}

function personHtmlLabel(p) {
  const n = formatNameLines(p);
  const birth = (p?.birth || '').trim();
  const death = (p?.death || '').trim();
  const gid = (p?.gramps_id || '').trim();

  const rows = [];

  for (const line of wrapTextLines(n.given, { maxCharsPerLine: 26, maxLines: 2 })) {
    if (!line) continue;
    rows.push(`<TR><TD ALIGN="LEFT">${htmlEsc(line)}</TD></TR>`);
  }

  for (const line of wrapTextLines(n.surname, { maxCharsPerLine: 26, maxLines: 2 })) {
    if (!line) continue;
    rows.push(`<TR><TD ALIGN="LEFT"><B>${htmlEsc(line)}</B></TD></TR>`);
  }

  if (birth) rows.push(`<TR><TD ALIGN="LEFT">* ${htmlEsc(birth)}</TD></TR>`);
  if (death) rows.push(`<TR><TD ALIGN="LEFT">&#8224; ${htmlEsc(death)}</TD></TR>`);
  if (!birth && !death && gid && p?.display_name === 'Private') {
    // Avoid fully blank cards.
    rows.push(`<TR><TD ALIGN="LEFT">${htmlEsc(gid)}</TD></TR>`);
  }

  return `<<TABLE BORDER="0" CELLBORDER="0" CELLPADDING="2" CELLSPACING="0">${rows.join('')}</TABLE>>`;
}

export function buildRelationshipDot(payload, { couplePriority = true } = {}) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];

  const peopleById = new Map(nodes.filter(n => n?.type === 'person' && n?.id).map(n => [String(n.id), n]));
  const familiesById = new Map(nodes.filter(n => n?.type === 'family' && n?.id).map(n => [String(n.id), n]));

  const famFather = new Map();
  const famMother = new Map();
  const parentsTotalByFamily = new Map();
  for (const [fid, f] of familiesById.entries()) {
    const pt = Number(f?.parents_total);
    if (Number.isFinite(pt) && pt >= 0) parentsTotalByFamily.set(fid, pt);
  }

  // Track which families each person is a parent in (for multi-spouse ordering).
  // pid -> [{ fid, partner }]
  const parentFamiliesByPerson = new Map();

  const hasAnyParentEdge = new Set();
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    const pid = String(e.from || '');
    const fid = String(e.to || '');
    if (!pid || !fid) continue;
    if (!familiesById.has(fid)) continue;
    if (peopleById.has(pid)) hasAnyParentEdge.add(fid);
    if (e.role === 'father') famFather.set(fid, pid);
    if (e.role === 'mother') famMother.set(fid, pid);
  }

  // Build per-person family membership once father/mother maps are ready.
  for (const fid of familiesById.keys()) {
    const fa = famFather.get(fid);
    const mo = famMother.get(fid);
    if (!fa || !mo) continue;
    if (!peopleById.has(fa) || !peopleById.has(mo)) continue;

    const a0 = parentFamiliesByPerson.get(fa) || [];
    a0.push({ fid, partner: mo });
    parentFamiliesByPerson.set(fa, a0);

    const a1 = parentFamiliesByPerson.get(mo) || [];
    a1.push({ fid, partner: fa });
    parentFamiliesByPerson.set(mo, a1);
  }

  const multiSpousePeople = new Set();
  const multiSpouseFamilies = new Set();
  for (const [pid, arr] of parentFamiliesByPerson.entries()) {
    const uniqFamilies = new Set((arr || []).map(x => x.fid));
    if (uniqFamilies.size >= 2) {
      multiSpousePeople.add(pid);
      for (const fid of uniqFamilies) multiSpouseFamilies.add(fid);
    }
  }

  // Cutoff-parent families: present in the payload but have no visible parent edges.
  // These families are only placeholders to allow an “expand parents” arrow.
  // We hide the hub and the dangling edge to the child.
  const cutoffParentFamilyIds = new Set();
  for (const fid of familiesById.keys()) {
    const pt = parentsTotalByFamily.has(fid) ? parentsTotalByFamily.get(fid) : null;
    if (pt !== null && Number.isFinite(pt) && pt <= 0) continue;
    if (!hasAnyParentEdge.has(fid)) cutoffParentFamilyIds.add(fid);
  }

  const lines = [];
  lines.push('digraph G {');
  lines.push('  compound=true;');
  lines.push('  rankdir=TB;');
  lines.push('  bgcolor="transparent";');
  // Gramps Web baseline: let Graphviz compute splayed polylines, then smooth in SVG.
  lines.push('  splines=polyline;');
  // Keep same-rank spacing tight so spouse ↔ hub can sit flush.
  lines.push('  nodesep=0;');
  lines.push('  ranksep=0.50;');
  lines.push('  pad=0.05;');
  lines.push('  graph [fontname="Inter, Segoe UI, Arial"];');
  lines.push('  node [fontname="Inter, Segoe UI, Arial", fontsize=10, color="#2a3446"];');
  lines.push('  edge [color="#556277", arrowsize=0.7, penwidth=1.6, arrowhead=none];');
  lines.push('  ordering=out;');

  for (const [pid, p] of peopleById.entries()) {
    const gender = String(p?.gender || 'U').toUpperCase();
    const rim = (gender === 'M') ? '#93A7BF' : (gender === 'F') ? '#C7A0AA' : '#B7B0A3';
    const body = '#d0d5dd';
    const label = personHtmlLabel(p);

    lines.push(
      `  ${dotId(pid)} [` +
      `shape=box, style="rounded,filled", penwidth=0,` +
      ` fixedsize=true, width=${PERSON_CARD_WIDTH_IN}, height=${PERSON_CARD_HEIGHT_IN},` +
      ` margin="0.00,0.00", fillcolor="${body}", color="${rim}", label=${label}` +
      `];`
    );
  }

  for (const [fid, f] of familiesById.entries()) {
    if (cutoffParentFamilyIds.has(fid)) {
      // Layout-only node (do not render a visible hub)
      lines.push(
        `  ${dotId(fid)} [` +
        `shape=point, width=0.01, height=0.01, fixedsize=true, style=invis, label=""` +
        `];`
      );
      continue;
    }
    const hasMore = !!f?.has_more_children;
    const fill = hasMore ? '#b28dff' : '#9d7bff';
    lines.push(
      `  ${dotId(fid)} [` +
      `shape=circle, width=0.26, height=0.26, fixedsize=true,` +
      ` style="filled", fillcolor="${fill}", fontcolor="#0b0f16", label="⚭"` +
      `];`
    );
  }

  // Encourage couple nodes to sit on one row with hub between them.
  if (couplePriority) {
    for (const fid of familiesById.keys()) {
      if (cutoffParentFamilyIds.has(fid)) continue;
      // Multi-spouse families are handled by a dedicated cluster for the shared person.
      if (multiSpouseFamilies.has(fid)) continue;
      const fa = famFather.get(fid);
      const mo = famMother.get(fid);
      const members = [fa, fid, mo].filter(Boolean);
      if (members.length <= 1) continue;

      // Use a real DOT cluster (name starts with cluster_) but keep it invisible.
      // This is the strongest nudge DOT has for keeping spouse blocks cohesive.
      if (fa && mo) {
        lines.push(`  subgraph ${dotId(`cluster_couple_${fid}`)} {`);
        lines.push('    cluster=true;');
        lines.push('    style=invis;');
        lines.push('    color=white;');
        lines.push('    label=".";');
        lines.push('    rank=same;');
        lines.push('    ordering=out;');
        lines.push(`    ${dotId(fa)}; ${dotId(fid)}; ${dotId(mo)};`);
        lines.push('  }');

        // Hard ordering: spouse - hub - spouse.
        // Keep these invisible so the debug-visible spouse→hub edges remain readable.
        lines.push(`  ${dotId(fa)} -> ${dotId(fid)} [style=invis, weight=50000, minlen=0, constraint=true, arrowhead=none];`);
        lines.push(`  ${dotId(fid)} -> ${dotId(mo)} [style=invis, weight=50000, minlen=0, constraint=true, arrowhead=none];`);
        // Extra glue: keep spouses adjacent even under conflicting constraints.
        lines.push(`  ${dotId(fa)} -> ${dotId(mo)} [style=invis, weight=100000, minlen=0, constraint=false, arrowhead=none];`);
      } else {
        // Single-parent family: only rank hint.
        lines.push(`  { rank=same; ${members.map(dotId).join('; ')}; }`);
      }
    }
  }

  // Multi-spouse: keep spouse–hub–common–hub–spouse chains cohesive.
  // Without this, Graphviz can pull the blocks apart under competing constraints.
  if (couplePriority) {
    for (const pid of multiSpousePeople) {
      const arr = (parentFamiliesByPerson.get(pid) || [])
        .filter(x => x && x.fid && x.partner)
        .filter(x => !cutoffParentFamilyIds.has(x.fid));
      if (arr.length < 2) continue;

      arr.sort((a, b) => String(a.fid).localeCompare(String(b.fid)));

      // Build an order like: partner1, fid1, pid, fid2, partner2, fid3, partner3...
      const seq = [];
      seq.push(arr[0].partner, arr[0].fid, pid);
      for (let i = 1; i < arr.length; i++) {
        seq.push(arr[i].fid, arr[i].partner);
      }

      const uniqSeq = [];
      const seen = new Set();
      for (const x of seq) {
        if (!x) continue;
        if (seen.has(x)) continue;
        seen.add(x);
        uniqSeq.push(x);
      }
      if (uniqSeq.length < 3) continue;

      lines.push(`  subgraph ${dotId(`cluster_multispouse_${pid}`)} {`);
      lines.push('    cluster=true;');
      lines.push('    style=invis;');
      lines.push('    color=white;');
      lines.push('    label=".";');
      lines.push('    rank=same;');
      lines.push('    ordering=out;');
      lines.push(`    ${uniqSeq.map(dotId).join('; ')};`);
      lines.push('  }');

      for (let i = 0; i < uniqSeq.length - 1; i++) {
        const a = uniqSeq[i];
        const b = uniqSeq[i + 1];
        lines.push(`  ${dotId(a)} -> ${dotId(b)} [style=invis, weight=200000, minlen=0, constraint=true, arrowhead=none];`);
      }
    }
  }

  for (const e of edges) {
    if (!e?.from || !e?.to) continue;
    const from = String(e.from);
    const to = String(e.to);

    if (e.type === 'parent') {
      if (!peopleById.has(from) || !familiesById.has(to)) continue;
      // Keep the spouse↔hub connector visible for troubleshooting, but avoid using it
      // as a rank constraint (we want hub and spouses on the same row).
      const hasTwoParents = !!(famFather.get(to) && famMother.get(to));
      if (hasTwoParents) {
        lines.push(`  ${dotId(from)} -> ${dotId(to)} [constraint=false, weight=3, minlen=0];`);
      } else {
        lines.push(`  ${dotId(from)} -> ${dotId(to)};`);
      }
      continue;
    }
    if (e.type === 'child') {
      if (!familiesById.has(from) || !peopleById.has(to)) continue;
      if (cutoffParentFamilyIds.has(from)) continue;
      lines.push(`  ${dotId(from)} -> ${dotId(to)};`);
      continue;
    }
  }

  lines.push('}');
  return lines.join('\n');
}
