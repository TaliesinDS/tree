from __future__ import annotations

from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Query
from fastapi import HTTPException

try:
    from ..db import db_conn
    from ..names import _format_public_person_names
    from ..privacy import _is_effectively_private
    from ..util import _compact_json
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn
    from names import _format_public_person_names
    from privacy import _is_effectively_private
    from util import _compact_json

router = APIRouter()


@router.get("/events/{event_id}")
def get_event(event_id: str, privacy: str = "on") -> dict[str, Any]:
    """Get a single event (privacy-safe).

    Accepts either the internal event id or Gramps id.

    Privacy rules:
    - Private events are hidden.
    - If the event references any effectively-private person, the event is hidden.
    - Private places are redacted (place=null).
    - Private notes are omitted.
    """

    ref = (event_id or "").strip()
    if not ref:
        raise HTTPException(status_code=404, detail="Not found")
    skip_priv = (privacy.lower() == "off")

    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT
              e.id,
              e.gramps_id,
              e.event_type,
              e.description,
              e.event_date_text,
              e.event_date,
              e.place_id,
              pl.name as place_name,
              pl.is_private as place_is_private,
              e.is_private
            FROM event e
            LEFT JOIN place pl ON pl.id = e.place_id
            WHERE e.id = %s OR e.gramps_id = %s
            LIMIT 1
            """.strip(),
            (ref, ref),
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Not found")

        (
            eid,
            egid,
            event_type,
            description,
            event_date_text,
            event_date,
            place_id0,
            place_name,
            place_is_private,
            event_is_private,
        ) = tuple(row)

        if bool(event_is_private):
            raise HTTPException(status_code=404, detail="Not found")

        pe_rows = conn.execute(
            """
            SELECT
              p.id,
              p.gramps_id,
              p.display_name,
              p.given_name,
              p.surname,
              p.birth_text,
              p.death_text,
              p.birth_date,
              p.death_date,
              p.is_living,
              p.is_private,
              p.is_living_override,
              pe.role
            FROM person_event pe
            JOIN person p ON p.id = pe.person_id
            WHERE pe.event_id = %s
            ORDER BY COALESCE(pe.role, '') NULLS LAST, p.display_name NULLS LAST, p.gramps_id NULLS LAST, p.id
            """.strip(),
            (eid,),
        ).fetchall()

        people: list[dict[str, Any]] = []
        for (
            pid0,
            pgid,
            display_name,
            given_name,
            surname,
            birth_text,
            death_text,
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
            role,
        ) in pe_rows:
            pid_s = str(pid0)
            is_private_eff = not skip_priv and _is_effectively_private(
                is_private=is_private_flag,
                is_living_override=is_living_override,
                is_living=is_living_flag,
                birth_date=birth_date,
                death_date=death_date,
                birth_text=birth_text,
                death_text=death_text,
            )
            if bool(is_private_eff):
                # Hide the whole event if any referenced person is private.
                raise HTTPException(status_code=404, detail="Not found")

            display_name_out, given_name_out, surname_out = _format_public_person_names(
                display_name=display_name,
                given_name=given_name,
                surname=surname,
            )
            people.append(
                {
                    "id": pid_s,
                    "gramps_id": pgid,
                    "display_name": display_name_out,
                    "given_name": given_name_out,
                    "surname": surname_out,
                    "role": str(role or "").strip() or None,
                }
            )

        note_rows = conn.execute(
            """
            SELECT n.id, n.body
            FROM event_note en
            JOIN note n ON n.id = en.note_id
            WHERE en.event_id = %s
              AND n.is_private = FALSE
            ORDER BY n.id
            """.strip(),
            (eid,),
        ).fetchall()
        notes: list[dict[str, Any]] = [
            {"id": str(nid), "body": body}
            for (nid, body) in note_rows
            if str(nid or "").strip()
        ]

        place_out = None
        if place_id0 and not bool(place_is_private):
            place_out = {"id": str(place_id0), "name": place_name}

        out = {
            "id": str(eid),
            "gramps_id": egid,
            "type": event_type,
            "date": event_date.isoformat() if isinstance(event_date, date) else None,
            "date_text": event_date_text,
            "description": description,
            "place": place_out,
            "people": people,
            "notes": notes,
        }
        return _compact_json(out) or out


@router.get("/events")
def list_events(
    limit: int = Query(default=500, ge=1, le=5_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
    q: Optional[str] = None,
    place_id: Optional[str] = None,
    sort: str = "type_asc",
    privacy: str = "on",
) -> dict[str, Any]:
    """List events in the database (privacy-safe).

    Notes:
    - Events with `event.is_private` are always hidden.
    - Additionally, events connected to any effectively-private person (or to any
      family that is private / has an effectively-private parent) are omitted.
    - Places that are private are redacted (place=null).

    This endpoint exists to power a global Events index in the UI.
    """

    with db_conn() as conn:
        def _has_col(table: str, col: str) -> bool:
            try:
                row = conn.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = %s AND column_name = %s
                    LIMIT 1
                    """.strip(),
                    (table, col),
                ).fetchone()
                return bool(row)
            except Exception:
                return False

        has_event_gramps_id = _has_col("event", "gramps_id")

        qn = (q or "").strip()
        q_like = f"%{qn}%" if qn else None

        pid = (place_id or "").strip() or None

        gramps_id_select = "e.gramps_id" if has_event_gramps_id else "NULL"

        sort_key = (sort or "type_asc").strip().lower()
        id_expr = f"COALESCE({gramps_id_select}, e.id)"
        base_order_by = {
            "type_asc": f"e.event_type NULLS LAST, e.event_date NULLS LAST, e.event_date_text NULLS LAST, {id_expr} NULLS LAST, e.id",
            "type_desc": f"e.event_type DESC NULLS LAST, e.event_date NULLS LAST, e.event_date_text NULLS LAST, {id_expr} NULLS LAST, e.id",
            "year_asc": f"(e.event_date IS NULL) ASC, e.event_date ASC, e.event_date_text NULLS LAST, e.event_type NULLS LAST, {id_expr} NULLS LAST, e.id",
            "year_desc": f"(e.event_date IS NULL) ASC, e.event_date DESC, e.event_date_text NULLS LAST, e.event_type NULLS LAST, {id_expr} NULLS LAST, e.id",
            "id_asc": f"{id_expr} NULLS LAST, e.id",
            "id_desc": f"{id_expr} DESC NULLS LAST, e.id",
        }.get(sort_key, f"e.event_type NULLS LAST, e.event_date NULLS LAST, e.event_date_text NULLS LAST, {id_expr} NULLS LAST, e.id")

        total = None
        if include_total:
            if q_like:
                if has_event_gramps_id:
                    total = conn.execute(
                        """
                        SELECT COUNT(*)
                        FROM event e
                        LEFT JOIN place pl ON pl.id = e.place_id
                        WHERE e.is_private = FALSE
                          AND (%s::text IS NULL OR e.place_id = %s::text)
                          AND (
                            e.event_type ILIKE %s
                            OR e.description ILIKE %s
                            OR e.event_date_text ILIKE %s
                            OR e.gramps_id ILIKE %s
                            OR pl.name ILIKE %s
                                                        OR EXISTS (
                                                            SELECT 1
                                                            FROM person_event pe
                                                            JOIN person p ON p.id = pe.person_id
                                                            WHERE pe.event_id = e.id
                                                                AND (
                                                                    p.display_name ILIKE %s
                                                                    OR p.given_name ILIKE %s
                                                                    OR p.surname ILIKE %s
                                                                    OR p.gramps_id ILIKE %s
                                                                )
                                                        )
                          )
                        """.strip(),
                        (pid, pid, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like),
                    ).fetchone()[0]
                else:
                    total = conn.execute(
                        """
                        SELECT COUNT(*)
                        FROM event e
                        LEFT JOIN place pl ON pl.id = e.place_id
                        WHERE e.is_private = FALSE
                          AND (%s::text IS NULL OR e.place_id = %s::text)
                          AND (
                            e.event_type ILIKE %s
                            OR e.description ILIKE %s
                            OR e.event_date_text ILIKE %s
                            OR pl.name ILIKE %s
                                                        OR EXISTS (
                                                            SELECT 1
                                                            FROM person_event pe
                                                            JOIN person p ON p.id = pe.person_id
                                                            WHERE pe.event_id = e.id
                                                                AND (
                                                                    p.display_name ILIKE %s
                                                                    OR p.given_name ILIKE %s
                                                                    OR p.surname ILIKE %s
                                                                    OR p.gramps_id ILIKE %s
                                                                )
                                                        )
                          )
                        """.strip(),
                        (pid, pid, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like),
                    ).fetchone()[0]
            else:
                total = conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM event e
                    WHERE e.is_private = FALSE
                      AND (%s::text IS NULL OR e.place_id = %s::text)
                    """.strip(),
                    (pid, pid),
                ).fetchone()[0]

        page_limit = int(limit)
        page_offset = int(offset)
        page_plus = page_limit + 1

        base_where = "e.is_private = FALSE"
        params: list[Any] = []
        if pid:
            base_where += " AND e.place_id = %s"
            params.append(pid)
        if q_like:
            if has_event_gramps_id:
                base_where += " AND (e.event_type ILIKE %s OR e.description ILIKE %s OR e.event_date_text ILIKE %s OR e.gramps_id ILIKE %s OR pl.name ILIKE %s OR EXISTS (SELECT 1 FROM person_event pe JOIN person p ON p.id = pe.person_id WHERE pe.event_id = e.id AND (p.display_name ILIKE %s OR p.given_name ILIKE %s OR p.surname ILIKE %s OR p.gramps_id ILIKE %s)))"
                params.extend([q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like])
            else:
                base_where += " AND (e.event_type ILIKE %s OR e.description ILIKE %s OR e.event_date_text ILIKE %s OR pl.name ILIKE %s OR EXISTS (SELECT 1 FROM person_event pe JOIN person p ON p.id = pe.person_id WHERE pe.event_id = e.id AND (p.display_name ILIKE %s OR p.given_name ILIKE %s OR p.surname ILIKE %s OR p.gramps_id ILIKE %s)))"
                params.extend([q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like])

        rows = conn.execute(
            f"""
            WITH base AS (
              SELECT
                e.id,
                {gramps_id_select} AS gramps_id,
                e.event_type,
                e.description,
                e.event_date_text,
                e.event_date,
                pl.id as place_id,
                pl.name as place_name,
                pl.is_private as place_is_private
              FROM event e
              LEFT JOIN place pl ON pl.id = e.place_id
              WHERE {base_where}
              ORDER BY {base_order_by}
              LIMIT %s OFFSET %s
            ),
            pe AS (
              SELECT
                pe.event_id,
                array_agg(pe.person_id ORDER BY pe.person_id) AS person_ids,
                array_agg(COALESCE(pe.role, '') ORDER BY pe.person_id) AS person_roles
              FROM person_event pe
              WHERE pe.event_id IN (SELECT id FROM base)
              GROUP BY pe.event_id
            ),
            fe AS (
              SELECT
                fe.event_id,
                array_agg(fe.family_id ORDER BY fe.family_id) AS family_ids
              FROM family_event fe
              WHERE fe.event_id IN (SELECT id FROM base)
              GROUP BY fe.event_id
            ),
            pf AS (
              SELECT DISTINCT ON (fe.event_id)
                fe.event_id,
                f.father_id AS primary_family_father_id
              FROM family_event fe
              JOIN family f ON f.id = fe.family_id
              WHERE fe.event_id IN (SELECT id FROM base)
              ORDER BY fe.event_id, f.gramps_id NULLS LAST, f.id
            )
            SELECT
              b.id,
              b.gramps_id,
              b.event_type,
              b.description,
              b.event_date_text,
              b.event_date,
              b.place_id,
              b.place_name,
              b.place_is_private,
              COALESCE(pe.person_ids, ARRAY[]::text[]) AS person_ids,
              COALESCE(pe.person_roles, ARRAY[]::text[]) AS person_roles,
              COALESCE(fe.family_ids, ARRAY[]::text[]) AS family_ids,
              pf.primary_family_father_id
            FROM base b
            LEFT JOIN pe ON pe.event_id = b.id
            LEFT JOIN fe ON fe.event_id = b.id
            LEFT JOIN pf ON pf.event_id = b.id
            ORDER BY {base_order_by.replace('e.', 'b.')}
            """.strip(),
            [*params, page_plus, page_offset],
        ).fetchall()

        has_more = len(rows) > page_limit
        if has_more:
            rows = rows[:page_limit]

        # Gather referenced ids for bulk privacy checks.
        person_ids: set[str] = set()
        family_ids: set[str] = set()
        for r in rows:
            pe_ids = r[9] or []
            fe_ids = r[11] or []
            for pid0 in pe_ids:
                if pid0:
                    person_ids.add(str(pid0))
            for fid0 in fe_ids:
                if fid0:
                    family_ids.add(str(fid0))
            pf0 = r[12]
            if pf0:
                person_ids.add(str(pf0))

        families_by_id: dict[str, dict[str, Any]] = {}
        family_parent_ids: set[str] = set()
        if family_ids:
            fam_rows = conn.execute(
                """
                SELECT id, father_id, mother_id, is_private
                FROM family
                WHERE id = ANY(%s)
                """.strip(),
                (list(family_ids),),
            ).fetchall()
            for fid, fa, mo, fam_is_private in fam_rows:
                fid_s = str(fid)
                families_by_id[fid_s] = {
                    "id": fid_s,
                    "father_id": str(fa) if fa else None,
                    "mother_id": str(mo) if mo else None,
                    "is_private": bool(fam_is_private),
                }
                if fa:
                    family_parent_ids.add(str(fa))
                if mo:
                    family_parent_ids.add(str(mo))

        all_people_ids = set(person_ids) | set(family_parent_ids)
        person_private_by_id: dict[str, bool] = {}
        person_public_by_id: dict[str, dict[str, Any]] = {}
        if all_people_ids:
            pr = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (list(all_people_ids),),
            ).fetchall()
            for (
                pid0,
                gid,
                display_name,
                given_name,
                surname,
                birth_text,
                death_text,
                birth_date,
                death_date,
                is_living_flag,
                is_private_flag,
                is_living_override,
            ) in pr:
                pid_s = str(pid0)
                is_private_eff = privacy.lower() != "off" and _is_effectively_private(
                    is_private=is_private_flag,
                    is_living_override=is_living_override,
                    is_living=is_living_flag,
                    birth_date=birth_date,
                    death_date=death_date,
                    birth_text=birth_text,
                    death_text=death_text,
                )

                person_private_by_id[pid_s] = bool(is_private_eff)
                if not bool(is_private_eff):
                    display_name_out, given_name_out, surname_out = _format_public_person_names(
                        display_name=display_name,
                        given_name=given_name,
                        surname=surname,
                    )
                    person_public_by_id[pid_s] = {
                        "id": pid_s,
                        "gramps_id": gid,
                        "display_name": display_name_out,
                        "given_name": given_name_out,
                        "surname": surname_out,
                    }

    results: list[dict[str, Any]] = []
    for r in rows:
        (
            eid,
            e_gramps_id,
            event_type,
            description,
            event_date_text,
            event_date,
            place_id0,
            place_name,
            place_is_private,
            pe_ids,
            pe_roles,
            fe_ids,
            primary_family_father_id,
        ) = tuple(r)

        pe_list = [str(x) for x in (pe_ids or []) if x]
        if any(person_private_by_id.get(pid0, False) for pid0 in pe_list):
            continue

        fe_list = [str(x) for x in (fe_ids or []) if x]
        family_ok = True
        for fid0 in fe_list:
            fam = families_by_id.get(fid0)
            if not fam:
                family_ok = False
                break
            if bool(fam.get("is_private")):
                family_ok = False
                break
            fa = fam.get("father_id")
            mo = fam.get("mother_id")
            if (fa and person_private_by_id.get(str(fa), False)) or (mo and person_private_by_id.get(str(mo), False)):
                family_ok = False
                break
        if not family_ok:
            continue

        primary_pid: str | None = None
        if primary_family_father_id:
            primary_pid = str(primary_family_father_id)
        else:
            roles = [str(x or "").strip() for x in (pe_roles or [])]
            pairs = list(zip(pe_list, roles))

            def _role_rank(role_raw: str) -> int:
                r0 = (role_raw or "").strip().lower()
                if not r0:
                    return 50
                if "husband" in r0:
                    return 0
                if "father" in r0:
                    return 1
                if "primary" in r0 or "principal" in r0 or "main" in r0:
                    return 2
                return 10

            pairs.sort(key=lambda pr0: (_role_rank(pr0[1]), pr0[0]))
            if pairs:
                primary_pid = pairs[0][0]

        primary_person = person_public_by_id.get(str(primary_pid)) if primary_pid else None

        place_out = None
        if place_id0 and not bool(place_is_private):
            place_out = {"id": place_id0, "name": place_name}

        results.append(
            {
                "id": eid,
                "gramps_id": e_gramps_id,
                "type": event_type,
                "date": event_date.isoformat() if isinstance(event_date, date) else None,
                "date_text": event_date_text,
                "description": description,
                "place": place_out,
                "people_total": len(pe_list),
                "families_total": len(fe_list),
                "primary_person": primary_person,
            }
        )

    next_offset = (page_offset + page_limit) if has_more else None
    out: dict[str, Any] = {
        "offset": offset,
        "limit": limit,
        "results": results,
        "has_more": bool(has_more),
        "next_offset": next_offset,
    }
    if include_total:
        out["total"] = int(total or 0)
    return _compact_json(out) or out
