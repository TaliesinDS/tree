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

const PERSON_CARD_WIDTH_IN = 1.80;
const PERSON_CARD_HEIGHT_IN = 1.10;

// Person-card label padding inside Graphviz's HTML-like table.
// Increase for more breathing room, decrease for tighter line spacing.
const PERSON_LABEL_CELL_PADDING = 1;

const HUB_DIAMETER_IN = 0.26;
const INLAW_GAP_IN = HUB_DIAMETER_IN * 0.50;      // ~half a hub
const UNRELATED_GAP_IN = HUB_DIAMETER_IN * 1.50;  // ~one and a half hubs

const COUPLE_CLUSTER_MARGIN_X_PT = Math.round(UNRELATED_GAP_IN * 72);

const RANKSEP_IN = 1.75;

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

const _MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const _MONTH_TOKEN_TO_NUM = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

function _formatDmyEnglish(day, monthNum, year) {
  const d = Number(day);
  const m = Number(monthNum);
  const y = Number(year);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return null;
  if (y < 0 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${d} ${_MONTHS_EN[m - 1]} ${y}`;
}

function _formatCardDateEnglishNoQualifier(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return '';

  // Year-only stays year-only.
  if (/^\d{4}$/.test(s0)) return s0;

  // ISO: YYYY-MM-DD (or YYYY-M-D)
  {
    const m = s0.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const out = _formatDmyEnglish(m[3], m[2], m[1]);
      if (out) return out;
    }
  }

  // Numeric: DD/MM/YYYY or DD-MM-YYYY (only when unambiguous)
  {
    const m = s0.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const y = m[3];
      if (Number.isFinite(a) && Number.isFinite(b)) {
        // If ambiguous (both <= 12), keep as-is to avoid swapping day/month.
        if (a <= 12 && b <= 12) return s0;
        // Otherwise interpret the >12 side as the day.
        if (a > 12 && b <= 12) {
          const out = _formatDmyEnglish(a, b, y);
          if (out) return out;
        }
        if (b > 12 && a <= 12) {
          const out = _formatDmyEnglish(b, a, y);
          if (out) return out;
        }
      }
    }
  }

  // Text month: "20 Oct 1920" / "20 October 1920"
  {
    const m = s0.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
    if (m) {
      const day = m[1];
      const token = String(m[2] || '').trim().toLowerCase();
      const monthNum = _MONTH_TOKEN_TO_NUM.get(token);
      if (monthNum) {
        const out = _formatDmyEnglish(day, monthNum, m[3]);
        if (out) return out;
      }
    }
  }

  // Otherwise (ranges, qualifiers, partial dates), keep original.
  return s0;
}

function formatCardDateEnglish(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return '';

  // Gramps-style qualifiers (render as English words).
  // Allow stacking: "estimated before 1920-10-20" → "estimated before 20 October 1920".
  const qualifiers = [
    { re: /^(estimated|est\.?|estimate)\s+/i, word: 'estimated' },
    { re: /^(before|bef\.?|befor)\s+/i, word: 'before' },
    { re: /^(after|aft\.?|aftr)\s+/i, word: 'after' },
    { re: /^(about|abt\.?|approx\.?|approximately|circa|ca\.?|c\.)\s+/i, word: 'about' },
    { re: /^(calculated|calc\.?|cal\.?|cal)\s+/i, word: 'calculated' },
  ];

  let rest = s0;
  const prefixWords = [];
  for (let guard = 0; guard < 4; guard++) {
    let matched = false;
    for (const q of qualifiers) {
      const m = rest.match(q.re);
      if (!m) continue;
      prefixWords.push(q.word);
      rest = rest.slice(m[0].length).trim();
      matched = true;
      break;
    }
    if (!matched) break;
  }

  if (!rest) return prefixWords.join(' ').trim();
  const formatted = _formatCardDateEnglishNoQualifier(rest);
  return prefixWords.length ? `${prefixWords.join(' ')} ${formatted}` : formatted;
}

function personHtmlLabel(p) {
  const n = formatNameLines(p);
  const birth = formatCardDateEnglish((p?.birth || '').trim());
  const death = formatCardDateEnglish((p?.death || '').trim());
  const gid = (p?.gramps_id || '').trim();

  const rows = [];

  for (const line of wrapTextLines(n.given, { maxCharsPerLine: 26, maxLines: 2 })) {
    if (!line) continue;
    rows.push(`<TR><TD ALIGN="LEFT"><B>${htmlEsc(line)}</B></TD></TR>`);
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

  return `<<TABLE BORDER="0" CELLBORDER="0" CELLPADDING="${PERSON_LABEL_CELL_PADDING}" CELLSPACING="0">${rows.join('')}</TABLE>>`;
}

export function buildRelationshipDot(payload, { couplePriority = true } = {}) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];

  const peopleById = new Map(nodes.filter(n => n?.type === 'person' && n?.id).map(n => [String(n.id), n]));
  const familiesById = new Map(nodes.filter(n => n?.type === 'family' && n?.id).map(n => [String(n.id), n]));

  const famFather = new Map();
  const famMother = new Map();
  const visibleParentCountByFamily = new Map();
  const parentPeopleInView = new Set();
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
    if (peopleById.has(pid)) {
      hasAnyParentEdge.add(fid);
      visibleParentCountByFamily.set(fid, (visibleParentCountByFamily.get(fid) || 0) + 1);
      parentPeopleInView.add(pid);
    }
    if (e.role === 'father') famFather.set(fid, pid);
    if (e.role === 'mother') famMother.set(fid, pid);
  }

  const singleParentFamilyIds = new Set();
  for (const [fid, n] of visibleParentCountByFamily.entries()) {
    if (Number(n) === 1) singleParentFamilyIds.add(fid);
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

  const childrenByFamily = new Map();
  for (const e of edges) {
    if (e?.type !== 'child') continue;
    const fid = String(e.from || '');
    const cid = String(e.to || '');
    if (!fid || !cid) continue;
    if (!familiesById.has(fid)) continue;
    if (!peopleById.has(cid)) continue;
    if (cutoffParentFamilyIds.has(fid)) continue;
    const arr = childrenByFamily.get(fid) || [];
    arr.push(cid);
    childrenByFamily.set(fid, arr);
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
  // Reduce built-in separation buffers so hub and spouse cards can get closer.
  // (DOT still avoids overlaps; this mainly removes extra whitespace padding.)
  lines.push('  sep="+0.0,+0.0";');
  lines.push('  esep="+0.0,+0.0";');
  lines.push(`  ranksep=${RANKSEP_IN};`);
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
    const pt0 = Number(f?.parents_total);
    if (Number.isFinite(pt0) && pt0 <= 0) {
      // Ghost / parentless family: treat as layout-only junction.
      lines.push(
        `  ${dotId(fid)} [` +
        `shape=point, width=0.01, height=0.01, fixedsize=true, style=invis, label=""` +
        `];`
      );
      continue;
    }

    if (cutoffParentFamilyIds.has(fid)) {
      // Layout-only node (do not render a visible hub)
      lines.push(
        `  ${dotId(fid)} [` +
        `shape=point, width=0.01, height=0.01, fixedsize=true, style=invis, label=""` +
        `];`
      );
      continue;
    }

    if (singleParentFamilyIds.has(fid)) {
      // Single-parent family: no visible hub. Keep a tiny invisible point as a
      // branch/junction for children.
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

  // Per-family sibling clusters: keep siblings tight.
  // - Between adjacent sibling blocks, add a small spacer when at least one side is a couple.
  // - Between unrelated sibling groups, add a larger spacer so they don't visually read as couples.
  for (const [fid, rawKids] of childrenByFamily.entries()) {
    const kids = (rawKids || [])
      .map(x => String(x))
      .filter(x => x && peopleById.has(x));
    // If someone is a parent in-view, don't pin them into a sibling row.
    // Otherwise DOT tends to keep them with siblings while their marriages drift away.
    const siblings = kids.filter(x => !parentPeopleInView.has(x));
    if (!siblings.length) continue;

    siblings.sort((a, b) => String(a).localeCompare(String(b)));

    const personHasTwoParentFamilyInView = (pid) => {
      const arr = parentFamiliesByPerson.get(String(pid)) || [];
      return arr.some(x => {
        const familyId = String(x?.fid || '');
        if (!familyId) return false;
        if (!familiesById.has(familyId)) return false;
        if (cutoffParentFamilyIds.has(familyId)) return false;
        if (singleParentFamilyIds.has(familyId)) return false;
        return !!x?.partner;
      });
    };

    const rowSeq = [];
    for (let i = 0; i < siblings.length; i++) {
      const a = siblings[i];
      rowSeq.push(a);

      if (i < siblings.length - 1) {
        const b = siblings[i + 1];
        if (personHasTwoParentFamilyInView(a) || personHasTwoParentFamilyInView(b)) {
          const gapId = `${fid}__inlaw_${i}`;
          lines.push(
            `  ${dotId(gapId)} [` +
            `shape=point, style=invis, width=${INLAW_GAP_IN.toFixed(2)}, height=0.01, fixedsize=true, label=""` +
            `];`
          );
          rowSeq.push(gapId);
        }
      }
    }

    const sepId = `${fid}__sep`;
    lines.push(
      `  ${dotId(sepId)} [` +
      `shape=point, style=invis, width=${UNRELATED_GAP_IN.toFixed(2)}, height=0.01, fixedsize=true, label=""` +
      `];`
    );

    lines.push(`  subgraph ${dotId(`cluster_children_${fid}`)} {`);
    lines.push('    style=invis;');
    lines.push('    rank=same;');
    lines.push('    ordering=out;');
    lines.push(`    ${rowSeq.map(dotId).join('; ')}; ${dotId(sepId)};`);
    lines.push('  }');

    for (let i = 0; i < rowSeq.length - 1; i++) {
      lines.push(`  ${dotId(rowSeq[i])} -> ${dotId(rowSeq[i + 1])} [style=invis, weight=220, constraint=false, minlen=0, arrowhead=none];`);
    }
    lines.push(`  ${dotId(rowSeq[rowSeq.length - 1])} -> ${dotId(sepId)} [style=invis, weight=220, constraint=false, minlen=0, arrowhead=none];`);
  }

  // Encourage couple nodes to sit on one row with hub between them.
  if (couplePriority) {
    for (const fid of familiesById.keys()) {
      if (cutoffParentFamilyIds.has(fid)) continue;
      if (singleParentFamilyIds.has(fid)) continue;
      // Multi-spouse families are handled by a dedicated cluster for the shared person.
      if (multiSpouseFamilies.has(fid)) continue;
      const fa = famFather.get(fid);
      const mo = famMother.get(fid);
      const members = [fa, fid, mo].filter(Boolean);
      if (members.length <= 1) continue;

      // Use a real DOT cluster (name starts with cluster_) but keep it invisible.
      // This is the strongest nudge DOT has for keeping spouse blocks cohesive.
      if (fa && mo) {
        const coupleSepId = `${fid}__couple_sep`;
        // Ensure unrelated couples/people don't read as a couple from afar.
        // Put the separator inside the couple cluster so it stays attached to the block.
        lines.push(
          `  ${dotId(coupleSepId)} [` +
          `shape=point, style=invis, width=${UNRELATED_GAP_IN.toFixed(2)}, height=0.01, fixedsize=true, label=""` +
          `];`
        );

        lines.push(`  subgraph ${dotId(`cluster_couple_${fid}`)} {`);
        lines.push('    cluster=true;');
        lines.push('    style=invis;');
        lines.push('    color=white;');
        lines.push('    label=".";');
        lines.push(`    margin="${COUPLE_CLUSTER_MARGIN_X_PT},0";`);
        lines.push('    rank=same;');
        lines.push('    ordering=out;');
        lines.push(`    ${dotId(fa)}; ${dotId(fid)}; ${dotId(mo)}; ${dotId(coupleSepId)};`);
        lines.push('  }');

        // Hard ordering: spouse - hub - spouse.
        // Keep these invisible so the debug-visible spouse→hub edges remain readable.
        lines.push(`  ${dotId(fa)} -> ${dotId(fid)} [style=invis, weight=50000, minlen=0, constraint=true, arrowhead=none];`);
        lines.push(`  ${dotId(fid)} -> ${dotId(mo)} [style=invis, weight=50000, minlen=0, constraint=true, arrowhead=none];`);
        lines.push(`  ${dotId(mo)} -> ${dotId(coupleSepId)} [style=invis, weight=8000, minlen=0, constraint=true, arrowhead=none];`);
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
      if (singleParentFamilyIds.has(to)) {
        // For single-parent families, the invisible family point acts as a junction.
        // Keep this edge as a layout constraint but do not render it.
        lines.push(`  ${dotId(from)} -> ${dotId(to)} [constraint=true, weight=200, minlen=1, style=invis];`);
        continue;
      }
      // Keep the spouse↔hub connector visible for troubleshooting, but avoid using it
      // as a rank constraint (we want hub and spouses on the same row).
      const hasTwoParents = !!(famFather.get(to) && famMother.get(to));
      if (hasTwoParents) {
        // Regular families: hide hub↔spouse connector lines.
        // Keep it as a (weak) non-constraint edge so the graph remains connected
        // for DOT heuristics, but don't render it.
        lines.push(`  ${dotId(from)} -> ${dotId(to)} [constraint=false, weight=3, minlen=0, style=invis];`);
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
