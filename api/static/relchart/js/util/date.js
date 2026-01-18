const _MONTHS_EN_LOWER = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
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

function _formatDmyEnglishLower(day, monthNum, year) {
  const d = Number(day);
  const m = Number(monthNum);
  const y = Number(year);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return null;
  if (y < 0 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${d} ${_MONTHS_EN_LOWER[m - 1]} ${y}`;
}

function _formatNoQualifier(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return '';

  // Year-only stays year-only.
  if (/^\d{4}$/.test(s0)) return s0;

  // ISO: YYYY-MM-DD (or YYYY-M-D)
  {
    const m = s0.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const out = _formatDmyEnglishLower(m[3], m[2], m[1]);
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
          const out = _formatDmyEnglishLower(a, b, y);
          if (out) return out;
        }
        if (b > 12 && a <= 12) {
          const out = _formatDmyEnglishLower(b, a, y);
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
        const out = _formatDmyEnglishLower(day, monthNum, m[3]);
        if (out) return out;
      }
    }
  }

  // Otherwise (ranges, qualifiers, partial dates), keep original.
  return s0;
}

/**
 * Formats Gramps-style dates as English DMY with lowercase month names.
 *
 * Examples:
 * - "2004-05-12" -> "12 may 2004"
 * - "12 May 2004" -> "12 may 2004"
 * - "estimated before 1920-10-20" -> "estimated before 20 october 1920"
 * - year-only remains unchanged
 */
export function formatGrampsDateEnglish(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return '';

  // Gramps-style qualifiers (render as English words).
  // Allow stacking: "estimated before 1920-10-20" → "estimated before 20 october 1920".
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
  const formatted = _formatNoQualifier(rest);
  return prefixWords.length ? `${prefixWords.join(' ')} ${formatted}` : formatted;
}
