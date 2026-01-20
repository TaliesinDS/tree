import { formatGrampsDateEnglish } from './date.js';

export function formatEventTitle(ev) {
  const t = String(ev?.type || ev?.event_type || 'Event').trim();
  return t || 'Event';
}

export function formatEventPlaceForSidebar(ev) {
  const full = String(ev?.place?.name || '').trim();
  if (!full) return '';

  // Heuristic: if the place ends with "Netherlands"/"Nederland" (or "NL"), hide the country.
  // If it's outside NL, keep the full place string (which should include the country).
  const parts = full.split(',').map(s => String(s).trim()).filter(Boolean);
  if (parts.length < 2) return full;
  const country = String(parts[parts.length - 1] || '').trim();
  if (/^(netherlands|nederland|nl)$/i.test(country)) {
    return parts.slice(0, -1).join(', ');
  }
  return full;
}

export function formatEventSubLine(ev) {
  const dateText = String(ev?.date || ev?.date_text || ev?.event_date || ev?.event_date_text || '').trim();
  const dateUi = dateText ? formatGrampsDateEnglish(dateText) : '';
  const placeName = formatEventPlaceForSidebar(ev);
  const parts = [];
  if (dateUi) parts.push(dateUi);
  if (placeName) parts.push(placeName);
  return parts.join(' · ');
}

export function formatEventSubLineNoPlace(ev) {
  const dateText = String(ev?.date || ev?.date_text || ev?.event_date || ev?.event_date_text || '').trim();
  const dateUi = dateText ? formatGrampsDateEnglish(dateText) : '';
  return dateUi;
}
