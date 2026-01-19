# Debug / Data Quality Reports (planned)

Goal: make it easy to identify “troublesome records” (especially **Places**) from Tree so they can be fixed in **Gramps Desktop** (source of truth).

This is intentionally a **read-only** debug/reporting concept.

---

## Why this exists

Some exports contain Places with:
- missing `place_type` (so we can’t label “Village/Province/Country”)
- missing `enclosed_by_id` (so they float as roots / wrong hierarchy)
- missing coordinates (`lat/lon`) (so map pins can’t be placed)
- weird capitalization / near-duplicate names (e.g. `ISRAEL`)

In the UI, these often show up as:
- places incorrectly “floating” at top level
- places being bucketed heuristically (e.g. under Netherlands)

We want a deterministic list of records to fix upstream.

---

## 1) Proposed output format

A report should be exportable as CSV/TSV/JSONL.

Recommended columns (for Places)
- `gramps_id`
- `id` (internal handle)
- `name`
- `place_type`
- `enclosed_by_gramps_id` (if resolvable)
- `enclosed_by_id`
- `lat`
- `lon`
- `problem_flags` (comma-separated)
- `suggested_bucket` (optional: NL/France/etc based on bbox heuristics)

Example flags
- `missing_type`
- `missing_parent`
- `missing_coords`
- `name_all_caps`
- `name_suspicious` (heuristics)

---

## 2) Suggested locations in repo

- Docs/spec: this file
- Implementation options:
  - FastAPI endpoint(s): `api/main.py`
  - One-off report script(s): `reports/` (preferred first step)

---

## 3) Implementation option A (preferred): report script

Create a script (planned): `reports/data_quality_places.py`

Inputs
- `DATABASE_URL` (same as API)

Outputs
- `reports/data_quality_places_<timestamp>.json`
- optionally CSV next to it

Pseudo-query logic
- read from `place` table
- compute flags:
  - missing type: `place_type IS NULL OR place_type = ''`
  - missing parent: `enclosed_by_id IS NULL OR enclosed_by_id = ''`
  - missing coords: `lat IS NULL OR lon IS NULL`
  - all-caps name: `name = UPPER(name)` (with non-letter guard)

SQL sketch
```sql
SELECT id, gramps_id, name, place_type, enclosed_by_id, lat, lon
FROM place
WHERE is_private = FALSE
  AND (
    COALESCE(place_type,'') = ''
    OR COALESCE(enclosed_by_id,'') = ''
    OR lat IS NULL OR lon IS NULL
  )
ORDER BY COALESCE(gramps_id, name) NULLS LAST, id;
```

---

## 4) Implementation option B: debug API endpoint

If we want this available from the browser (still read-only):

Proposed endpoint
- `GET /debug/data-quality/places`

Query params
- `limit` (default 5000)
- `offset`
- `include` (comma-separated flags to include)
- `only_missing_parent=true|false`
- `only_missing_type=true|false`
- `only_missing_coords=true|false`

Response
```json
{
  "results": [
    {
      "id": "_...",
      "gramps_id": "P0177",
      "name": "absregt",
      "type": null,
      "enclosed_by_id": null,
      "lat": null,
      "lon": null,
      "problem_flags": ["missing_type","missing_parent","missing_coords"]
    }
  ]
}
```

Security/Privacy
- same rule as the rest of Tree: never return private records.

---

## 5) Quick manual checks (today)

While the above is “planned”, you can already spot missing-data places via the API:

```powershell
# Example: fetch a specific place by Gramps ID via search
Invoke-RestMethod "http://127.0.0.1:8080/places?limit=50&offset=0&q=P0177" |
  Select-Object -ExpandProperty results |
  Where-Object { $_.gramps_id -eq 'P0177' } |
  ConvertTo-Json -Depth 6
```

---

## 6) Other future data-quality reports (nice-to-have)

- People:
  - missing birth/death but marked not-living
  - suspicious dates (death before birth)
  - missing surname for most records
- Events:
  - missing type
  - missing date_text
  - missing place_id
- Places:
  - duplicate-ish names within same parent (normalize/compare)

