from __future__ import annotations

from datetime import date
import re
from typing import Any

import psycopg

try:
    from .names import _format_public_person_names
    from .privacy import _is_effectively_living, _is_effectively_private
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from names import _format_public_person_names
    from privacy import _is_effectively_living, _is_effectively_private


def _people_core_many(conn: psycopg.Connection, person_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch privacy-redacted core person payloads for many internal person ids."""

    if not person_ids:
        return {}

    rows = conn.execute(
        """
        SELECT id, gramps_id, display_name, given_name, surname, gender,
               birth_text, death_text, birth_date, death_date,
               is_living, is_private, is_living_override
        FROM person
        WHERE id = ANY(%s)
        """.strip(),
        (person_ids,),
    ).fetchall()

    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        (
            pid,
            gid,
            display_name,
            given_name,
            surname,
            gender,
            birth_text,
            death_text,
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
        ) = tuple(r)

        should_redact = _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
        )

        if should_redact:
            living_effective = _is_effectively_living(
                is_living_override=is_living_override,
                is_living=is_living_flag,
                death_date=death_date,
            )
            out[str(pid)] = {
                "id": pid,
                "gramps_id": gid,
                "display_name": "Private",
                "given_name": None,
                "surname": None,
                "gender": None,
                "birth": None,
                "death": None,
                "is_living": True if living_effective is None else bool(living_effective),
                "is_private": True,
            }
            continue

        display_name_out, given_name_out, surname_out = _format_public_person_names(
            display_name=display_name,
            given_name=given_name,
            surname=surname,
        )

        out[str(pid)] = {
            "id": pid,
            "gramps_id": gid,
            "display_name": display_name_out,
            "given_name": given_name_out,
            "surname": surname_out,
            "gender": gender,
            "birth": birth_text,
            "death": death_text,
            "is_living": bool(is_living_flag) if is_living_flag is not None else None,
            "is_private": bool(is_private_flag),
        }

    return out


def _fetch_family_marriage_date_map(
    conn: psycopg.Connection,
    family_ids: list[str],
) -> dict[str, str]:
    """Return a best-effort marriage date/text for each family id.

    Output value is either an ISO date (YYYY-MM-DD) from event.event_date,
    or a raw Gramps date text from event.event_date_text.

    Privacy: only returns dates for non-private events (event.is_private = false).
    Callers should still avoid attaching this to private families.
    """

    if not family_ids:
        return {}

    # Use parameterized ILIKE patterns so psycopg doesn't treat literal '%' as placeholders.
    pat_marriage = "%marriage%"
    pat_wedding = "%wedding%"

    rows = conn.execute(
        """
        SELECT DISTINCT ON (fe.family_id)
               fe.family_id,
               e.event_date,
               e.event_date_text
        FROM family_event fe
        JOIN event e ON e.id = fe.event_id
        WHERE fe.family_id = ANY(%s)
          AND COALESCE(e.is_private, FALSE) = FALSE
          AND (
            e.event_type ILIKE %s
            OR e.event_type ILIKE %s
          )
        ORDER BY fe.family_id,
                 e.event_date NULLS LAST,
                 e.event_date_text NULLS LAST,
                 e.id
        """.strip(),
        (family_ids, pat_marriage, pat_wedding),
    ).fetchall()

    out: dict[str, str] = {}
    for fid, ev_date, ev_text in rows:
        if ev_date is not None:
            out[str(fid)] = ev_date.isoformat()
        elif ev_text:
            out[str(fid)] = str(ev_text)

    # Fallback: some DBs may not have family_event populated.
    # In that case, Gramps often links the marriage event to both spouses as person_event.
    missing = [str(fid) for fid in family_ids if str(fid) not in out]
    if missing:
        # Fallback: infer “marriage” as any shared marriage-type event between the two parents
        # of the family (since this dataset has 0 rows in family_event).
        rows2 = conn.execute(
            """
            WITH fam AS (
              SELECT id, father_id, mother_id
              FROM family
              WHERE id = ANY(%s)
                AND father_id IS NOT NULL
                AND mother_id IS NOT NULL
            )
            SELECT DISTINCT ON (fam.id)
                   fam.id,
                   e.event_date,
                   e.event_date_text
            FROM fam
            JOIN person_event pe_fa ON pe_fa.person_id = fam.father_id
            JOIN person_event pe_mo ON pe_mo.person_id = fam.mother_id
                                 AND pe_mo.event_id = pe_fa.event_id
            JOIN event e ON e.id = pe_fa.event_id
            WHERE COALESCE(e.is_private, FALSE) = FALSE
              AND (
                e.event_type ILIKE %s
                OR e.event_type ILIKE %s
              )
            ORDER BY fam.id,
                     e.event_date NULLS LAST,
                     e.event_date_text NULLS LAST,
                     e.id
            """.strip(),
            (missing, pat_marriage, pat_wedding),
        ).fetchall()

        for fid, ev_date, ev_text in rows2:
            if str(fid) in out:
                continue
            if ev_date is not None:
                out[str(fid)] = ev_date.isoformat()
            elif ev_text:
                out[str(fid)] = str(ev_text)

    return out


def _year_hint_from_fields(
    *,
    birth_date: date | None,
    death_date: date | None,
    birth_text: str | None,
    death_text: str | None,
) -> int | None:
    """Return a best-effort year hint from structured and text dates."""

    if birth_date is not None:
        return birth_date.year
    if death_date is not None:
        return death_date.year
    for s in (birth_text, death_text):
        if not s:
            continue
        m = re.search(r"\b(\d{4})\b", str(s))
        if not m:
            continue
        try:
            y = int(m.group(1))
        except ValueError:
            continue
        if 1 <= y <= date.today().year + 5:
            return y
    return None
