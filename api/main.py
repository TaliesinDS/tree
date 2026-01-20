from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any, Literal, Optional

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastapi import Body
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

try:
    from .routes.demo import router as demo_router
    from .routes.health import router as health_router
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from routes.demo import router as demo_router
    from routes.health import router as health_router

try:
    from .routes.graph import router as graph_router
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from routes.graph import router as graph_router

try:
    from .routes.people import router as people_router
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from routes.people import router as people_router

try:
    from .db import db_conn
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn

try:
    from .privacy import _PRIVACY_AGE_CUTOFF_YEARS, _is_effectively_living, _is_effectively_private
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from privacy import _PRIVACY_AGE_CUTOFF_YEARS, _is_effectively_living, _is_effectively_private

try:
    from .names import _format_public_person_names, _normalize_public_name_fields, _smart_title_case_name
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from names import _format_public_person_names, _normalize_public_name_fields, _smart_title_case_name

try:
    from .graph import _bfs_neighborhood, _bfs_neighborhood_distances, _fetch_neighbors, _fetch_spouses
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from graph import _bfs_neighborhood, _bfs_neighborhood_distances, _fetch_neighbors, _fetch_spouses

try:
    from .queries import _fetch_family_marriage_date_map, _people_core_many, _year_hint_from_fields
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from queries import _fetch_family_marriage_date_map, _people_core_many, _year_hint_from_fields

try:
    from .resolve import _resolve_person_id
except ImportError:  # pragma: no cover
    from resolve import _resolve_person_id

try:
    from .serialize import _person_node_row_to_public
except ImportError:  # pragma: no cover
    from serialize import _person_node_row_to_public

try:
    from .util import _compact_json
except ImportError:  # pragma: no cover
    from util import _compact_json

app = FastAPI(title="Genealogy API", version="0.0.1")


_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


app.include_router(health_router)
app.include_router(demo_router)
app.include_router(graph_router)
app.include_router(people_router)


@app.get("/people")
def list_people(
    limit: int = Query(default=5000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
) -> dict[str, Any]:
    """List people in the database (privacy-redacted).

    This endpoint is intended for building a global People index in the UI.
    Use limit/offset pagination for large datasets.
    """

    with db_conn() as conn:
        total = None
        if include_total:
            total = conn.execute("SELECT COUNT(*) FROM person").fetchone()[0]

        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname,
                   birth_text, death_text, birth_date, death_date,
                   is_living, is_private, is_living_override
            FROM person
            ORDER BY display_name NULLS LAST, id
            LIMIT %s OFFSET %s
            """.strip(),
            (limit, offset),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for r in rows:
        (
            pid,
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
        ) = tuple(r)

        def _year_hint(bd: date | None, dd: date | None, bt: str | None, dt: str | None) -> tuple[int | None, int | None]:
            by = bd.year if bd is not None else None
            dy = dd.year if dd is not None else None

            def _year_from_text(s: str | None) -> int | None:
                if not s:
                    return None
                m = re.search(r"\b(\d{4})\b", str(s))
                if not m:
                    return None
                try:
                    y = int(m.group(1))
                except ValueError:
                    return None
                if y < 1 or y > date.today().year + 5:
                    return None
                return y

            if by is None:
                by = _year_from_text(bt)
            if dy is None:
                dy = _year_from_text(dt)
            return by, dy

        if _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
            birth_text=birth_text,
            death_text=death_text,
        ):
            results.append(
                {
                    "id": pid,
                    "gramps_id": gid,
                    "type": "person",
                    "display_name": "Private",
                    "given_name": None,
                    "surname": None,
                    "birth_year": None,
                    "death_year": None,
                }
            )
        else:
            display_name_out, given_name_out, surname_out = _format_public_person_names(
                display_name=display_name,
                given_name=given_name,
                surname=surname,
            )
            by, dy = _year_hint(birth_date, death_date, birth_text, death_text)
            results.append(
                {
                    "id": pid,
                    "gramps_id": gid,
                    "type": "person",
                    "display_name": display_name_out,
                    "given_name": given_name_out,
                    "surname": surname_out,
                    "birth_year": by,
                    "death_year": dy,
                }
            )

    out: dict[str, Any] = {
        "offset": offset,
        "limit": limit,
        "results": results,
    }
    if include_total:
        out["total"] = int(total or 0)
    return out


@app.get("/families")
def list_families(
    limit: int = Query(default=5000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
) -> dict[str, Any]:
    """List families in the database (privacy-safe).

    Intended for building a global Families index in the UI.
    """

    with db_conn() as conn:
        total = None
        if include_total:
            total = conn.execute("SELECT COUNT(*) FROM family").fetchone()[0]

        rows = conn.execute(
            """
            SELECT f.id, f.gramps_id, f.father_id, f.mother_id, f.is_private,
                   COALESCE(ct.children_total, 0) AS children_total
            FROM family f
            LEFT JOIN (
              SELECT family_id, COUNT(*)::int AS children_total
              FROM family_child
              GROUP BY family_id
            ) ct ON ct.family_id = f.id
            ORDER BY f.gramps_id NULLS LAST, f.id
            LIMIT %s OFFSET %s
            """.strip(),
            (limit, offset),
        ).fetchall()

        # Gather parent ids for bulk lookup.
        parent_ids: set[str] = set()
        family_ids_public: list[str] = []
        for fid, fgid, fa, mo, fam_is_private, children_total in rows:
            if bool(fam_is_private):
                continue
            family_ids_public.append(str(fid))
            if fa:
                parent_ids.add(str(fa))
            if mo:
                parent_ids.add(str(mo))

        parents_by_id: dict[str, dict[str, Any]] = {}
        if parent_ids:
            parent_rows = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname, gender,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (list(parent_ids),),
            ).fetchall()
            for pr in parent_rows:
                p_public = _person_node_row_to_public(tuple(pr), distance=None)
                parents_by_id[str(p_public.get("id"))] = {
                    "id": p_public.get("id"),
                    "gramps_id": p_public.get("gramps_id"),
                    "display_name": p_public.get("display_name"),
                    "is_private": (p_public.get("display_name") == "Private"),
                }

        marriage_by_family: dict[str, str] = {}
        if family_ids_public:
            marriage_by_family = _fetch_family_marriage_date_map(conn, family_ids_public)

    results: list[dict[str, Any]] = []
    for fid, fgid, fa, mo, fam_is_private, children_total in rows:
        if bool(fam_is_private):
            results.append(
                {
                    "id": fid,
                    "gramps_id": None,
                    "is_private": True,
                    "father": None,
                    "mother": None,
                    "parents_total": None,
                    "children_total": 0,
                    "marriage": None,
                }
            )
            continue

        father = parents_by_id.get(str(fa)) if fa else None
        mother = parents_by_id.get(str(mo)) if mo else None
        parents_total = int(bool(fa)) + int(bool(mo))
        results.append(
            {
                "id": fid,
                "gramps_id": fgid,
                "is_private": False,
                "father": father,
                "mother": mother,
                "parents_total": parents_total,
                "children_total": int(children_total or 0),
                "marriage": marriage_by_family.get(str(fid)),
            }
        )

    out: dict[str, Any] = {
        "offset": offset,
        "limit": limit,
        "results": results,
    }
    if include_total:
        out["total"] = int(total or 0)
    return out


@app.get("/events")
def list_events(
    limit: int = Query(default=500, ge=1, le=5_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
    q: Optional[str] = None,
    place_id: Optional[str] = None,
    sort: str = "type_asc",
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
            for pid in pe_ids:
                if pid:
                    person_ids.add(str(pid))
            for fid in fe_ids:
                if fid:
                    family_ids.add(str(fid))
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
                pid,
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
                pid_s = str(pid)
                is_private_eff = _is_effectively_private(
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
            place_id,
            place_name,
            place_is_private,
            pe_ids,
            pe_roles,
            fe_ids,
            primary_family_father_id,
        ) = tuple(r)

        pe_list = [str(x) for x in (pe_ids or []) if x]
        if any(person_private_by_id.get(pid, False) for pid in pe_list):
            continue

        fe_list = [str(x) for x in (fe_ids or []) if x]
        family_ok = True
        for fid in fe_list:
            fam = families_by_id.get(fid)
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

            pairs.sort(key=lambda pr: (_role_rank(pr[1]), pr[0]))
            if pairs:
                primary_pid = pairs[0][0]

        primary_person = person_public_by_id.get(str(primary_pid)) if primary_pid else None

        place_out = None
        if place_id and not bool(place_is_private):
            place_out = {"id": place_id, "name": place_name}

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


@app.get("/places/events_counts")
def places_events_counts() -> dict[str, Any]:
    """Return per-place event counts (privacy-safe).

    Used by the Map tab to decide whether to show the per-place events menu.

    Notes:
    - Counts only include events where event.is_private = FALSE.
    - Only includes non-private places.
    """

    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT
              e.place_id AS place_id,
              COUNT(*)::int AS events_total
            FROM event e
            JOIN place p ON p.id = e.place_id
            WHERE e.is_private = FALSE
              AND p.is_private = FALSE
              AND e.place_id IS NOT NULL
            GROUP BY e.place_id
            """.strip()
        ).fetchall()

    results = [{"place_id": str(pid), "events_total": int(n)} for (pid, n) in rows]
    out: dict[str, Any] = {"results": results}
    return _compact_json(out) or out


@app.get("/places")
def list_places(
    limit: int = Query(default=50_000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    q: Optional[str] = None,
) -> dict[str, Any]:
    """List places in the database (privacy-safe).

    Notes:
    - Places with `place.is_private` are always hidden.
    - This is a global index used by the Map tab (hierarchical place list).
    """

    qn = (q or "").strip()
    q_like = f"%{qn}%" if qn else None

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

        has_place_gramps_id = _has_col("place", "gramps_id")
        has_place_type = _has_col("place", "place_type")
        has_enclosed_by = _has_col("place", "enclosed_by_id")

        gramps_id_select = "p.gramps_id" if has_place_gramps_id else "NULL"
        type_select = "p.place_type" if has_place_type else "NULL"
        enclosed_by_select = "p.enclosed_by_id" if has_enclosed_by else "NULL"

        where = "p.is_private = FALSE"
        params: list[Any] = []
        if q_like:
            where += f" AND (p.name ILIKE %s OR {gramps_id_select} ILIKE %s OR {type_select} ILIKE %s)"
            params.extend([q_like, q_like, q_like])

        rows = conn.execute(
            f"""
            SELECT
              p.id,
              {gramps_id_select} AS gramps_id,
              p.name,
              {type_select} AS place_type,
              {enclosed_by_select} AS enclosed_by_id,
              p.lat,
              p.lon
            FROM place p
            WHERE {where}
            ORDER BY COALESCE({gramps_id_select}, p.name) NULLS LAST, p.id
            LIMIT %s OFFSET %s
            """.strip(),
            [*params, limit, offset],
        ).fetchall()

        by_id: dict[str, dict[str, Any]] = {}
        results: list[dict[str, Any]] = []
        for (pid, gramps_id, name, place_type, enclosed_by_id, lat, lon) in rows:
            rec = {
                "id": str(pid),
                "gramps_id": gramps_id,
                "name": name,
                "type": place_type,
                "enclosed_by_id": enclosed_by_id,
                "lat": lat,
                "lon": lon,
            }
            by_id[rec["id"]] = rec
            results.append(rec)

        # If this page window doesn't include parents, fetch missing ancestors so
        # the UI can still show an enclosure chain. This is bounded and only walks
        # upward via enclosed_by_id.
        if has_enclosed_by and results:
            to_fetch: set[str] = set()
            for rec in results:
                pid = rec.get("enclosed_by_id")
                if pid:
                    to_fetch.add(str(pid))

            depth = 0
            while to_fetch and depth < 16:
                batch = [pid for pid in to_fetch if pid not in by_id]
                to_fetch = set()
                if not batch:
                    break

                anc_rows = conn.execute(
                    f"""
                    SELECT
                      p.id,
                      {gramps_id_select} AS gramps_id,
                      p.name,
                      {type_select} AS place_type,
                      {enclosed_by_select} AS enclosed_by_id
                    FROM place p
                    WHERE p.is_private = FALSE AND p.id = ANY(%s)
                    """.strip(),
                    (batch,),
                ).fetchall()

                for (pid, gramps_id, name, place_type, enclosed_by_id) in anc_rows:
                    rec = {
                        "id": str(pid),
                        "gramps_id": gramps_id,
                        "name": name,
                        "type": place_type,
                        "enclosed_by_id": enclosed_by_id,
                        "lat": None,
                        "lon": None,
                    }
                    by_id[rec["id"]] = rec

                    nxt = rec.get("enclosed_by_id")
                    if nxt:
                        nxt = str(nxt)
                        if nxt not in by_id:
                            to_fetch.add(nxt)

                depth += 1

        # Add enclosure chain for each returned place.
        enclosure_cache: dict[str, list[dict[str, Any]]] = {}

        def _enclosure_for(pid: str) -> list[dict[str, Any]]:
            if pid in enclosure_cache:
                return enclosure_cache[pid]
            out: list[dict[str, Any]] = []
            seen: set[str] = set()
            cur = by_id.get(pid)
            while cur:
                parent_id = cur.get("enclosed_by_id")
                if not parent_id:
                    break
                parent_id = str(parent_id)
                if parent_id in seen:
                    break
                seen.add(parent_id)
                parent = by_id.get(parent_id)
                if not parent:
                    break
                out.append(
                    {
                        "id": parent.get("id"),
                        "gramps_id": parent.get("gramps_id"),
                        "name": parent.get("name"),
                        "type": parent.get("type"),
                    }
                )
                cur = parent
            enclosure_cache[pid] = out
            return out

        for rec in results:
            rec["enclosure"] = _enclosure_for(rec["id"])

    return _compact_json({"offset": offset, "limit": limit, "results": results}) or {
        "offset": offset,
        "limit": limit,
        "results": results,
    }


def _bfs_path(
    conn: psycopg.Connection,
    start: str,
    goal: str,
    *,
    max_hops: int,
    max_nodes: int,
) -> list[str]:
    if start == goal:
        return [start]

    parents: dict[str, str | None] = {start: None}
    depth: dict[str, int] = {start: 0}
    frontier = [start]

    visited_nodes = 1
    while frontier:
        if visited_nodes > max_nodes:
            raise HTTPException(status_code=400, detail="path search exceeded max_nodes")

        # Stop expanding beyond max_hops.
        if max(depth[n] for n in frontier) >= max_hops:
            break

        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []

        for node in frontier:
            node_depth = depth[node]
            if node_depth >= max_hops:
                continue

            for nb in neigh.get(node, []):
                if nb in parents:
                    continue
                parents[nb] = node
                depth[nb] = node_depth + 1
                visited_nodes += 1

                if nb == goal:
                    # reconstruct
                    path = [goal]
                    cur = node
                    while cur is not None:
                        path.append(cur)
                        cur = parents[cur]
                    path.reverse()
                    return path

                next_frontier.append(nb)

        frontier = next_frontier

    return []


@app.get("/relationship/path")
def relationship_path(
    from_id: str = Query(min_length=1, max_length=64),
    to_id: str = Query(min_length=1, max_length=64),
    max_hops: int = Query(default=12, ge=1, le=50),
) -> dict[str, Any]:
    resolved_from = _resolve_person_id(from_id)
    resolved_to = _resolve_person_id(to_id)

    with db_conn() as conn:
        path_ids = _bfs_path(conn, resolved_from, resolved_to, max_hops=max_hops, max_nodes=100_000)
        if not path_ids:
            return {"from": from_id, "to": to_id, "path": []}

        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name,
                   birth_date, death_date, is_living, is_private, is_living_override
            FROM person
            WHERE id = ANY(%s)
            """.strip(),
            (path_ids,),
        ).fetchall()
        by_id = {
            r[0]: {
                "id": r[0],
                "gramps_id": r[1],
                "display_name": (
                    "Private"
                    if _is_effectively_private(
                        is_private=r[6],
                        is_living_override=r[7],
                        is_living=r[5],
                        birth_date=r[3],
                        death_date=r[4],
                    )
                    else _smart_title_case_name(r[2])
                ),
            }
            for r in rows
        }

    return {
        "from": from_id,
        "to": to_id,
        "path": [by_id.get(pid, {"id": pid, "display_name": None}) for pid in path_ids],
        "hops": max(0, len(path_ids) - 1),
    }


@app.get("/places/{place_id}")
def get_place(place_id: str) -> dict[str, Any]:
    # Placeholder.
    return {
        "id": place_id,
        "name": f"Place {place_id}",
        "lat": None,
        "lon": None,
    }


def is_living(birth: date | None, death: date | None, living_cutoff_years: int = _PRIVACY_AGE_CUTOFF_YEARS) -> bool:
    """Conservative living heuristic for public views.

    - If death is known: not living.
    - If birth is unknown: treat as living (privacy-first).
    - If birth within cutoff: living.

    This should be *configurable* and overrideable per person.
    """

    if death is not None:
        return False
    if birth is None:
        return True

    today = date.today()
    age_years = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
    return age_years < living_cutoff_years
