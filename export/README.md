# Export pipeline (Gramps SQLite → public website DB)

You said:
- Gramps SQLite is your **working** DB (offline).
- The website uses an **exported/sanitized** version.

This folder contains tooling to:
1) inspect your Gramps DB schema (no guessing)
2) export a normalized, privacy-safe dataset for the website backend

## Step 1: Inspect the Gramps DB
Run the inspector and save a report:

```powershell
# from repo root
.\export\inspect_gramps_sqlite.ps1 -DbPath "C:\path\to\your\gramps.sqlite" -OutDir .\reports
```

This writes a timestamped JSON report with:
- table list
- columns
- foreign keys
- indexes

## Step 2: Build the exporter
After inspection, we implement the real exporter based on **Gramps XML**.

Why XML instead of direct SQLite?
- In the SQLite DB, many key fields live in `blob_data` (Gramps internal serialization).
- Gramps XML (`.gramps`) is stable, documented-ish, and contains the rich data we need.

Export from a `.gramps` file:

```powershell
# 1) Export from Gramps: File -> Export -> Gramps XML (.gramps)
# 2) Run exporter
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$out = ".\reports\gramps_export_$ts"
\export\export_gramps_package.ps1 -InPath "C:\path\to\export.gpkg" -OutDir $out
```

This writes `people.jsonl`, `person_parent.jsonl`, `events.jsonl`, `notes.jsonl`, `places.jsonl`, etc.

Redaction defaults:
- living people are exported as `"Private"` with no dates
- `private` records are redacted too

You can disable redaction for local-only debugging with `--no-redact-living` / `--no-redact-private`.

If you still want a SQLite-based exporter later, we can do it, but it requires decoding Gramps `blob_data`.
- read Person / Family / Event / Place / Note
- build parent edges (child→parent)
- compute `is_living` and `is_private` flags
- redact private fields before writing export

## Privacy rule
Default is conservative: unknown birth → treat as living.
See `../PRIVACY.md` (server-side rules and thresholds).
