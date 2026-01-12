# Privacy rules (draft)

Goal: public genealogy site, but living people are automatically private.

## Data classification
- **Public**: deceased people and their facts, historical notes, sources.
- **Private**: living people’s names, dates, places, notes, media.

## Living detection (default)
Conservative rules (privacy-first):
- If death date exists → **not living**.
- If birth date unknown → **treat as living**.
- Else if birth is within N years (default N=110) → **living**.

## Overrides
- `is_private` (manual): always private, even if deceased.
- `is_living_override` (manual): force living/not-living if you need exceptions.

## Public rendering behavior
- Living person shows as: "Private" (stable ID still exists so relationships can be navigated).
- Relationship paths are allowed to traverse living nodes, but the API redacts their fields.

## Why server-side matters
Anything sent to the browser is effectively public. So the API must apply redaction before returning JSON.
