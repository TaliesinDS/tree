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
  rows.push(`<TR><TD ALIGN="LEFT">${htmlEsc(n.given)}</TD></TR>`);
  rows.push(`<TR><TD ALIGN="LEFT"><B>${htmlEsc(n.surname)}</B></TD></TR>`);
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
  for (const e of edges) {
    if (e?.type !== 'parent') continue;
    const pid = String(e.from || '');
    const fid = String(e.to || '');
    if (!pid || !fid) continue;
    if (!familiesById.has(fid)) continue;
    if (e.role === 'father') famFather.set(fid, pid);
    if (e.role === 'mother') famMother.set(fid, pid);
  }

  const lines = [];
  lines.push('digraph G {');
  lines.push('  rankdir=TB;');
  lines.push('  bgcolor="transparent";');
  lines.push('  splines=ortho;');
  lines.push('  nodesep=0.20;');
  lines.push('  ranksep=0.50;');
  lines.push('  pad=0.05;');
  lines.push('  graph [fontname="Inter, Segoe UI, Arial"];');
  lines.push('  node [fontname="Inter, Segoe UI, Arial", fontsize=10, color="#2a3446"];');
  lines.push('  edge [color="#556277", arrowsize=0.7, penwidth=1.6, arrowhead=none];');

  for (const [pid, p] of peopleById.entries()) {
    const gender = String(p?.gender || 'U').toUpperCase();
    const rim = (gender === 'M') ? '#93A7BF' : (gender === 'F') ? '#C7A0AA' : '#B7B0A3';
    const body = '#d0d5dd';
    const label = personHtmlLabel(p);

    lines.push(
      `  ${dotId(pid)} [` +
      `shape=box, style="rounded,filled", penwidth=0, margin="0.06,0.04",` +
      ` fillcolor="${body}", color="${rim}", label=${label}` +
      `];`
    );
  }

  for (const [fid, f] of familiesById.entries()) {
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
      const fa = famFather.get(fid);
      const mo = famMother.get(fid);
      const members = [fa, fid, mo].filter(Boolean);
      if (members.length <= 1) continue;

      lines.push(`  subgraph ${dotId(`cluster_${fid}`)} {`);
      lines.push('    rank=same;');
      for (const m of members) lines.push(`    ${dotId(m)};`);
      lines.push('  }');

      // Invisible ordering edges
      if (fa) lines.push(`  ${dotId(fa)} -> ${dotId(fid)} [style=invis, weight=20];`);
      if (mo) lines.push(`  ${dotId(fid)} -> ${dotId(mo)} [style=invis, weight=20];`);
    }
  }

  for (const e of edges) {
    if (!e?.from || !e?.to) continue;
    const from = String(e.from);
    const to = String(e.to);

    if (e.type === 'parent') {
      if (!peopleById.has(from) || !familiesById.has(to)) continue;
      lines.push(`  ${dotId(from)} -> ${dotId(to)};`);
      continue;
    }
    if (e.type === 'child') {
      if (!familiesById.has(from) || !peopleById.has(to)) continue;
      lines.push(`  ${dotId(from)} -> ${dotId(to)};`);
      continue;
    }
  }

  lines.push('}');
  return lines.join('\n');
}
