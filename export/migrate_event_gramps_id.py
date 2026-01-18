"""Apply a small DB migration: add event.gramps_id (E0001) support.

Usage (PowerShell):
  $env:DATABASE_URL = "postgresql://..."
  .\.venv\Scripts\python.exe .\export\migrate_event_gramps_id.py

This keeps the migration intentionally narrow and safe to re-run.
"""

from __future__ import annotations

import os
import sys

import psycopg


DDL = [
    "ALTER TABLE event ADD COLUMN IF NOT EXISTS gramps_id TEXT NULL;",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_gramps_id ON event(gramps_id);",
]


def main() -> int:
    database_url = (os.environ.get("DATABASE_URL") or "").strip()
    if not database_url:
        print("Missing DATABASE_URL env var.", file=sys.stderr)
        return 2

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            for stmt in DDL:
                cur.execute(stmt)
        conn.commit()

    print("OK: ensured event.gramps_id column + idx_event_gramps_id")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
