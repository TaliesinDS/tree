from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

try:
    from ..db import db_conn
    from ..queries import _fetch_family_marriage_date_map
    from ..serialize import _person_node_row_to_public
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn
    from queries import _fetch_family_marriage_date_map
    from serialize import _person_node_row_to_public

router = APIRouter()


@router.get("/families")
def list_families(
    limit: int = Query(default=5000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
    privacy: str = "on",
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
        for fid, _fgid, fa, mo, fam_is_private, _children_total in rows:
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
                p_public = _person_node_row_to_public(tuple(pr), distance=None, skip_privacy=(privacy.lower() == "off"))
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
