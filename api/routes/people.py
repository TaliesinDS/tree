from __future__ import annotations

from datetime import date
import re
from typing import Any, Optional

import psycopg
from fastapi import APIRouter, HTTPException, Query, Request

try:
    from ..db import db_conn
    from ..names import _format_public_person_names, _smart_title_case_name
    from ..privacy import _is_effectively_living, _is_effectively_private
    from ..queries import _people_core_many
    from ..resolve import _resolve_person_id
    from ..util import _compact_json
    from ..routes.media import resolve_portrait_url
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn
    from names import _format_public_person_names, _smart_title_case_name
    from privacy import _is_effectively_living, _is_effectively_private
    from queries import _people_core_many
    from resolve import _resolve_person_id
    from util import _compact_json
    from routes.media import resolve_portrait_url

router = APIRouter()


def _slug(request: Request) -> str | None:
    return getattr(request.state, "instance_slug", None)


def _enforce_guest_privacy(request: Request, privacy: str) -> str:
    user = getattr(request.state, "user", None)
    if user and user.get("role") == "guest" and privacy.lower() == "off":
        return "on"
    return privacy


@router.get("/people")
def list_people(
    request: Request,
    limit: int = Query(default=5000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
    privacy: str = "on",
) -> dict[str, Any]:
    """List people in the database (privacy-redacted).

    This endpoint is intended for building a global People index in the UI.
    Use limit/offset pagination for large datasets.
    """
    privacy = _enforce_guest_privacy(request, privacy)

    with db_conn(_slug(request)) as conn:
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

        def _year_hint(
            bd: date | None,
            dd: date | None,
            bt: str | None,
            dt: str | None,
        ) -> tuple[int | None, int | None]:
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
        ) and privacy.lower() != "off":
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


@router.get("/people/{person_id}")
def get_person(person_id: str, request: Request, privacy: str = "on") -> dict[str, Any]:
    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")
    privacy = _enforce_guest_privacy(request, privacy)
    slug = _slug(request)

    resolved_id = _resolve_person_id(person_id, slug)

    with db_conn(slug) as conn:
        row = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname, gender,
                   birth_text, death_text, birth_date, death_date,
                   is_living, is_private, is_living_override
            FROM person
            WHERE id = %s
            """.strip(),
            (resolved_id,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="person not found")

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
    ) = tuple(row)

    person = {
        "id": pid,
        "gramps_id": gid,
        "display_name": display_name,
        "given_name": given_name,
        "surname": surname,
        "gender": gender,
        "birth_text": birth_text,
        "death_text": death_text,
        "is_living": is_living_flag,
        "is_private": is_private_flag,
    }

    should_redact = privacy.lower() != "off" and _is_effectively_private(
        is_private=person.get("is_private"),
        is_living_override=is_living_override,
        is_living=person.get("is_living"),
        birth_date=birth_date,
        death_date=death_date,
    )

    # Enforce privacy even if upstream export forgot.
    if should_redact:
        living_effective = _is_effectively_living(
            is_living_override=is_living_override,
            is_living=person.get("is_living"),
            death_date=death_date,
        )
        return {
            "id": person["id"],
            "gramps_id": person.get("gramps_id"),
            "display_name": "Private",
            "given_name": None,
            "surname": None,
            "gender": None,
            "birth": None,
            "death": None,
            "is_living": True if living_effective is None else bool(living_effective),
            "is_private": True,
        }

    display_name_out, given_name_out, surname_out = _format_public_person_names(
        display_name=person.get("display_name"),
        given_name=person.get("given_name"),
        surname=person.get("surname"),
    )

    return {
        "id": person["id"],
        "gramps_id": person.get("gramps_id"),
        "display_name": display_name_out,
        "given_name": given_name_out,
        "surname": surname_out,
        "gender": person.get("gender"),
        "birth": person.get("birth_text"),
        "death": person.get("death_text"),
        "is_living": bool(person.get("is_living")) if person.get("is_living") is not None else None,
        "is_private": bool(person.get("is_private")),
    }


@router.get("/people/{person_id}/details")
def get_person_details(person_id: str, request: Request, privacy: str = "on") -> dict[str, Any]:
    """Richer person payload for the UI detail panel.

    Returns:
    - person: same privacy-redacted core as /people/{id}
    - events: events attached to person (privacy-filtered)
    - gramps_notes: notes attached to person (privacy-filtered)

    Future tabs (placeholders): user_notes, media, sources, other.
    """

    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")
    privacy = _enforce_guest_privacy(request, privacy)
    slug = _slug(request)

    resolved_id = _resolve_person_id(person_id, slug)
    person_core = get_person(resolved_id, request, privacy=privacy)

    # If person is private/redacted, don't leak associated edges/notes.
    if privacy.lower() != "off" and (bool(person_core.get("is_private")) or person_core.get("display_name") == "Private"):
        out = {
            "person": person_core,
            "events": [],
            "gramps_notes": [],
            "user_notes": [],
            "media": [],
            "sources": [],
            "other": {},
        }
        return _compact_json(out) or {"person": person_core}

    with db_conn(slug) as conn:
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

        # Person events
        gramps_id_select = "e.gramps_id" if has_event_gramps_id else "NULL"
        ev_rows = conn.execute(
            f"""
            SELECT
              e.id,
              {gramps_id_select} AS gramps_id,
              e.event_type,
              e.description,
              e.event_date_text,
              e.event_date,
              e.is_private,
              pe.role,
              pl.id as place_id,
              pl.name as place_name,
              pl.is_private as place_is_private
            FROM person_event pe
            JOIN event e ON e.id = pe.event_id
            LEFT JOIN place pl ON pl.id = e.place_id
            WHERE pe.person_id = %s
            ORDER BY e.event_date NULLS LAST, e.event_date_text NULLS LAST, e.event_type NULLS LAST, e.id
            """.strip(),
            (resolved_id,),
        ).fetchall()

        events: list[dict[str, Any]] = []
        event_ids: list[str] = []
        for r in ev_rows:
            (
                eid,
                e_gramps_id,
                event_type,
                description,
                event_date_text,
                event_date,
                event_is_private,
                role,
                place_id,
                place_name,
                place_is_private,
            ) = tuple(r)

            if bool(event_is_private):
                continue

            event_ids.append(str(eid))
            place_out = None
            if place_id and (not bool(place_is_private)):
                place_out = {"id": place_id, "name": place_name}

            events.append(
                {
                    "id": eid,
                    "gramps_id": e_gramps_id,
                    "type": event_type,
                    "role": role,
                    "date": event_date.isoformat() if isinstance(event_date, date) else None,
                    "date_text": event_date_text,
                    "description": description,
                    "place": place_out,
                }
            )

        # Notes attached directly to the person (Gramps Notes tab)
        note_rows = conn.execute(
            """
            SELECT n.id, n.body, n.is_private
            FROM person_note pn
            JOIN note n ON n.id = pn.note_id
            WHERE pn.person_id = %s
            ORDER BY n.id
            """.strip(),
            (resolved_id,),
        ).fetchall()

        gramps_notes: list[dict[str, Any]] = []
        for nr in note_rows:
            nid, body, is_private = tuple(nr)
            if bool(is_private):
                continue
            gramps_notes.append({"id": nid, "body": body})

        # Optional: attach event notes (if present) into the event objects.
        if event_ids:
            ev_note_rows = conn.execute(
                """
                SELECT en.event_id, n.id, n.body, n.is_private
                FROM event_note en
                JOIN note n ON n.id = en.note_id
                WHERE en.event_id = ANY(%s)
                ORDER BY en.event_id, n.id
                """.strip(),
                (event_ids,),
            ).fetchall()

            notes_by_event: dict[str, list[dict[str, Any]]] = {}
            for er in ev_note_rows:
                ev_id, nid, body, is_private = tuple(er)
                if bool(is_private):
                    continue
                notes_by_event.setdefault(str(ev_id), []).append({"id": nid, "body": body})

            if notes_by_event:
                for ev in events:
                    ev_id = str(ev.get("id") or "")
                    if not ev_id:
                        continue
                    if ev_id in notes_by_event:
                        ev["notes"] = notes_by_event[ev_id]

        # Resolve portrait URL
        portrait_url = None
        media_list: list[dict[str, Any]] = []
        try:
            portrait_url = resolve_portrait_url(conn, resolved_id, skip_privacy=(privacy.lower() == "off"))
        except Exception:
            pass

        # Fetch person media for the media tab
        try:
            pm_rows = conn.execute(
                """
                SELECT pm.media_id, m.gramps_id, m.description, m.mime,
                       m.width, m.height, pm.sort_order, pm.is_portrait,
                       pm.region_x1, pm.region_y1, pm.region_x2, pm.region_y2,
                       m.is_private
                FROM person_media pm
                JOIN media m ON m.id = pm.media_id
                WHERE pm.person_id = %s
                ORDER BY pm.sort_order
                """.strip(),
                (resolved_id,),
            ).fetchall()
            for mr in pm_rows:
                (mid, mgid, mdesc, mmime, mw, mh, msort, mport,
                 rx1, ry1, rx2, ry2, m_priv) = mr
                if bool(m_priv) and privacy.lower() != "off":
                    continue
                ext = ".jpg"
                if mmime:
                    ext_map = {
                        "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                        "image/svg+xml": ".svg", "image/webp": ".webp",
                    }
                    ext = ext_map.get(mmime.lower(), ".jpg")
                entry = {
                    "id": mid,
                    "gramps_id": mgid,
                    "description": mdesc,
                    "mime": mmime,
                    "thumb_url": f"/media/file/thumb/{mid}.jpg",
                    "original_url": f"/media/file/original/{mid}{ext}",
                    "width": mw,
                    "height": mh,
                    "sort_order": msort,
                    "is_portrait": bool(mport),
                }
                if rx1 is not None:
                    entry["region"] = {"x1": rx1, "y1": ry1, "x2": rx2, "y2": ry2}
                media_list.append(entry)
        except Exception:
            pass

    person_core["portrait_url"] = portrait_url

    out = {
        "person": person_core,
        "events": events,
        "gramps_notes": gramps_notes,
        "user_notes": [],
        "media": media_list,
        "sources": [],
        "other": {},
    }
    return _compact_json(out) or {"person": person_core}


@router.get("/people/{person_id}/relations")
def get_person_relations(person_id: str, request: Request, privacy: str = "on") -> dict[str, Any]:
    """Relationship-style payload for the UI Relations tab (Gramps-like).

    Returns:
    - person: same privacy-redacted core as /people/{id}
    - parents: list[person]
    - siblings: list[person]
    - families: list[{ id, gramps_id, spouse: person|null, children: list[person] }]
    """

    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")
    privacy = _enforce_guest_privacy(request, privacy)
    slug = _slug(request)

    resolved_id = _resolve_person_id(person_id, slug)
    person_core = get_person(resolved_id, request, privacy=privacy)

    # If person is private/redacted, don't leak relationship graph.
    if privacy.lower() != "off" and (bool(person_core.get("is_private")) or person_core.get("display_name") == "Private"):
        out = {
            "person": person_core,
            "parents": [],
            "siblings": [],
            "families": [],
        }
        return _compact_json(out) or {"person": person_core}

    with db_conn(slug) as conn:
        # Parents from person_parent (direct edges)
        parent_ids_pp = [
            str(r[0])
            for r in conn.execute(
                "SELECT parent_id FROM person_parent WHERE child_id = %s",
                (resolved_id,),
            ).fetchall()
        ]

        # Families where person is a child
        fam_as_child = [
            str(r[0])
            for r in conn.execute(
                "SELECT family_id FROM family_child WHERE child_id = %s",
                (resolved_id,),
            ).fetchall()
        ]

        parent_ids_family: list[str] = []
        sibling_ids_family: list[str] = []
        if fam_as_child:
            fam_rows = conn.execute(
                """
                SELECT id, father_id, mother_id, is_private
                FROM family
                WHERE id = ANY(%s)
                """.strip(),
                (fam_as_child,),
            ).fetchall()

            # Parents via family father/mother, and siblings via family children.
            for _fid, fa, mo, fam_is_private in fam_rows:
                if bool(fam_is_private):
                    continue
                if fa:
                    parent_ids_family.append(str(fa))
                if mo:
                    parent_ids_family.append(str(mo))

            sib_rows = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = ANY(%s)
                """.strip(),
                (fam_as_child,),
            ).fetchall()
            for _fid, cid in sib_rows:
                if str(cid) != str(resolved_id):
                    sibling_ids_family.append(str(cid))

        # Siblings via shared parents (person_parent) as a fallback / for half-siblings.
        parent_ids_all = set(parent_ids_pp) | set(parent_ids_family)
        sibling_ids_pp: list[str] = []
        if parent_ids_all:
            sib_pp_rows = conn.execute(
                """
                SELECT DISTINCT child_id
                FROM person_parent
                WHERE parent_id = ANY(%s)
                """.strip(),
                (list(parent_ids_all),),
            ).fetchall()
            for (cid,) in sib_pp_rows:
                if str(cid) != str(resolved_id):
                    sibling_ids_pp.append(str(cid))

        # Families where person is a parent
        fam_as_parent_rows = conn.execute(
            """
            SELECT id, gramps_id, father_id, mother_id, is_private
            FROM family
            WHERE father_id = %s OR mother_id = %s
            ORDER BY gramps_id NULLS LAST, id
            """.strip(),
            (resolved_id, resolved_id),
        ).fetchall()

        fam_ids_as_parent = [str(r[0]) for r in fam_as_parent_rows if not bool(r[4])]
        children_by_family: dict[str, list[str]] = {}
        if fam_ids_as_parent:
            fc_rows = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = ANY(%s)
                ORDER BY family_id, child_id
                """.strip(),
                (fam_ids_as_parent,),
            ).fetchall()
            for fid, cid in fc_rows:
                children_by_family.setdefault(str(fid), []).append(str(cid))

        # Gather all referenced people ids for one bulk privacy-redacted fetch.
        parent_ids = sorted({*parent_ids_all} - {str(resolved_id)})
        sibling_ids = sorted({*sibling_ids_family, *sibling_ids_pp} - {str(resolved_id)})

        spouse_ids: set[str] = set()
        child_ids: set[str] = set()
        for fid, _gid, fa, mo, fam_is_private in fam_as_parent_rows:
            if bool(fam_is_private):
                continue
            other = None
            if fa and str(fa) != str(resolved_id):
                other = str(fa)
            if mo and str(mo) != str(resolved_id):
                other = str(mo)
            if other:
                spouse_ids.add(other)
            for cid in children_by_family.get(str(fid), []):
                child_ids.add(str(cid))

        all_people_ids = sorted({*parent_ids, *sibling_ids, *spouse_ids, *child_ids})
        people_by_id = _people_core_many(conn, all_people_ids, skip_privacy=(privacy.lower() == "off"))

        parents_out = [people_by_id[i] for i in parent_ids if i in people_by_id]
        siblings_out = [people_by_id[i] for i in sibling_ids if i in people_by_id]

        families_out: list[dict[str, Any]] = []
        for fid, gid, fa, mo, fam_is_private in fam_as_parent_rows:
            if bool(fam_is_private):
                continue
            fid_s = str(fid)
            spouse_id = None
            if fa and str(fa) != str(resolved_id):
                spouse_id = str(fa)
            if mo and str(mo) != str(resolved_id):
                spouse_id = str(mo)
            spouse_out = people_by_id.get(spouse_id) if spouse_id else None
            kids = [people_by_id[cid] for cid in children_by_family.get(fid_s, []) if cid in people_by_id]
            families_out.append(
                {
                    "id": fid_s,
                    "gramps_id": gid,
                    "spouse": spouse_out,
                    "children": kids,
                }
            )

    out = {
        "person": person_core,
        "parents": parents_out,
        "siblings": siblings_out,
        "families": families_out,
    }
    return _compact_json(out) or {"person": person_core}


@router.get("/people/search")
def search_people(request: Request, q: str = Query(min_length=1, max_length=200), privacy: str = "on") -> dict[str, Any]:
    privacy = _enforce_guest_privacy(request, privacy)
    q_like = f"%{q}%"
    with db_conn(_slug(request)) as conn:
        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name,
                   birth_date, death_date, is_living, is_private, is_living_override
            FROM person
            WHERE display_name ILIKE %s
            ORDER BY display_name
            LIMIT 25
            """.strip(),
            (q_like,),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for r in rows:
        (
            pid,
            gid,
            display_name,
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
        ) = tuple(r)

        # Always redact per privacy policy.
        if privacy.lower() != "off" and _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
        ):
            results.append({"id": pid, "gramps_id": gid, "display_name": "Private"})
        else:
            results.append({"id": pid, "gramps_id": gid, "display_name": _smart_title_case_name(display_name)})

    return {"query": q, "results": results}
