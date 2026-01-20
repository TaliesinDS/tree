from __future__ import annotations

from fastapi import HTTPException

try:
    from .db import db_conn
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn


def _resolve_person_id(person_ref: str) -> str:
    """Resolve either an internal handle (_abc...) or a Gramps ID (I0001) to the internal handle."""

    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT id
            FROM person
            WHERE id = %s OR gramps_id = %s
            LIMIT 1
            """.strip(),
            (person_ref, person_ref),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"person not found: {person_ref}")
    return row[0]
