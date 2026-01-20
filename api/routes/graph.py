from __future__ import annotations

from datetime import date
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, HTTPException, Query

try:
    from ..db import db_conn
    from ..graph import _bfs_neighborhood_distances
    from ..privacy import _is_effectively_private
    from ..queries import _fetch_family_marriage_date_map, _people_core_many, _year_hint_from_fields
    from ..resolve import _resolve_person_id
    from ..serialize import _person_node_row_to_public
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn
    from graph import _bfs_neighborhood_distances
    from privacy import _is_effectively_private
    from queries import _fetch_family_marriage_date_map, _people_core_many, _year_hint_from_fields
    from resolve import _resolve_person_id
    from serialize import _person_node_row_to_public

router = APIRouter()

# If someone is connected (parent/child) to a clearly-historic public person,
# we can safely assume they are not living, even if their own dates are missing.
_HISTORIC_YEAR_CUTOFF_YEARS_AGO = 150


@router.post("/graph/places")
def graph_places(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Return distinct public places referenced by events for a set of people.

    This is intended to power the Map "Scope: Current graph" pins without making
    N separate /people/{id}/details calls.

    Privacy:
    - Private/living people are excluded via the same person redaction policy.
    - Private events are excluded (event.is_private = false).
    - Private places are excluded.
    """

    person_ids_raw = payload.get("person_ids") or []
    if not isinstance(person_ids_raw, list):
        raise HTTPException(status_code=400, detail="person_ids must be a list")

    person_ids: list[str] = []
    for x in person_ids_raw:
        s = str(x).strip()
        if not s:
            continue
        person_ids.append(s)

    # Hard guardrails to avoid huge requests.
    person_ids = person_ids[:800]

    limit_raw = payload.get("limit")
    try:
        limit = int(limit_raw) if limit_raw is not None else 5000
    except Exception:
        limit = 5000
    limit = max(1, min(50_000, limit))

    if not person_ids:
        return {"results": [], "total": 0}

    with db_conn() as conn:
        # Apply privacy/redaction policy to the input people ids first.
        cores = _people_core_many(conn, person_ids)
        public_person_ids: list[str] = []
        for pid, p in cores.items():
            # _people_core_many already redacts: private people have display_name="Private".
            if p.get("display_name") == "Private":
                continue
            if bool(p.get("is_private")):
                continue
            public_person_ids.append(str(pid))

        if not public_person_ids:
            return {"results": [], "total": 0}

        rows = conn.execute(
            """
            SELECT DISTINCT
              pl.id,
              pl.gramps_id,
              pl.name,
              pl.lat,
              pl.lon
            FROM person_event pe
            JOIN event e ON e.id = pe.event_id
            JOIN place pl ON pl.id = e.place_id
            WHERE pe.person_id = ANY(%s)
              AND e.is_private = FALSE
              AND pl.is_private = FALSE
              AND pl.lat IS NOT NULL
              AND pl.lon IS NOT NULL
            LIMIT %s
            """.strip(),
            (public_person_ids, limit),
        ).fetchall()

        results: list[dict[str, Any]] = []
        for pid, gid, name, lat, lon in rows:
            results.append(
                {
                    "id": str(pid),
                    "gramps_id": str(gid) if gid else None,
                    "name": name,
                    "lat": float(lat) if lat is not None else None,
                    "lon": float(lon) if lon is not None else None,
                }
            )

    return {"results": results, "total": len(results)}


@router.get("/graph/neighborhood")
def graph_neighborhood(
    id: str = Query(min_length=1, max_length=64),
    depth: int = Query(default=2, ge=0, le=100),
    max_nodes: int = Query(default=1000, ge=1, le=6000),
    layout: Literal["family", "direct"] = Query(default="family"),
) -> dict[str, Any]:
    """Return a small subgraph for interactive exploration.

    - layout=family: Gramps-like family hub nodes (family + person nodes)
    - layout=direct: person nodes only with parent/spouse edges
    """

    root_id = _resolve_person_id(id)

    with db_conn() as conn:
        distances = _bfs_neighborhood_distances(conn, root_id, depth=depth, max_nodes=max_nodes)
        person_ids = list(distances.keys())

        person_rows = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname, gender,
                   birth_text, death_text, birth_date, death_date,
                   is_living, is_private, is_living_override
            FROM person
            WHERE id = ANY(%s)
            """.strip(),
            (person_ids,),
        ).fetchall()

        # Privacy is primarily decided per-person, but for graph exploration we can
        # safely unredact an undated person if they are directly connected
        # (parent/child) to a clearly-historic *already-public* neighbor.
        # This avoids false "Private" cards for medieval/early-modern people whose
        # dates are missing (common in imported trees).
        historic_year_cutoff = date.today().year - _HISTORIC_YEAR_CUTOFF_YEARS_AGO

        base_private: dict[str, bool] = {}
        year_hint_by_pid: dict[str, int | None] = {}
        row_by_pid: dict[str, tuple[Any, ...]] = {}

        for r_any in person_rows:
            r = tuple(r_any)
            (
                pid,
                gid,
                name,
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
            ) = r

            row_by_pid[str(pid)] = r
            year_hint_by_pid[str(pid)] = _year_hint_from_fields(
                birth_date=birth_date,
                death_date=death_date,
                birth_text=birth_text,
                death_text=death_text,
            )
            base_private[str(pid)] = _is_effectively_private(
                is_private=is_private_flag,
                is_living_override=is_living_override,
                is_living=is_living_flag,
                birth_date=birth_date,
                death_date=death_date,
                birth_text=birth_text,
                death_text=death_text,
            )

        # Build parent/child adjacency among the in-view people.
        # We include both person_parent (direct) and family/family_child (hub-based)
        # relations, because some imports may have incomplete person_parent rows.
        neighbor_pids: dict[str, set[str]] = {str(pid): set() for pid in row_by_pid.keys()}

        def _add_neighbor(a: str | None, b: str | None) -> None:
            if not a or not b:
                return
            if a not in neighbor_pids or b not in neighbor_pids:
                return
            neighbor_pids[a].add(b)
            neighbor_pids[b].add(a)

        # 1) Direct parent links
        pc_rows = conn.execute(
            """
            SELECT parent_id, child_id
            FROM person_parent
            WHERE parent_id = ANY(%s) AND child_id = ANY(%s)
            """.strip(),
            (person_ids, person_ids),
        ).fetchall()
        for parent_id, child_id in pc_rows:
            _add_neighbor(str(parent_id), str(child_id))

        # 2) Family-based links (parents/children through family hubs)
        fam_rows_priv = conn.execute(
            """
            SELECT DISTINCT f.id, f.father_id, f.mother_id
            FROM family f
            LEFT JOIN family_child fc ON fc.family_id = f.id
            WHERE f.father_id = ANY(%s)
               OR f.mother_id = ANY(%s)
               OR fc.child_id = ANY(%s)
            """.strip(),
            (person_ids, person_ids, person_ids),
        ).fetchall()

        family_ids_in_view: list[str] = []
        fam_parents: dict[str, list[str]] = {}
        for fid, father_id, mother_id in fam_rows_priv:
            fid_s = str(fid)
            family_ids_in_view.append(fid_s)
            ps: list[str] = []
            if father_id:
                ps.append(str(father_id))
            if mother_id:
                ps.append(str(mother_id))
            fam_parents[fid_s] = ps

        if family_ids_in_view:
            fc_rows_priv = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = ANY(%s)
                """.strip(),
                (family_ids_in_view,),
            ).fetchall()
            for family_id, child_id in fc_rows_priv:
                fid_s = str(family_id)
                cid_s = str(child_id)
                for pid_s in fam_parents.get(fid_s, []):
                    _add_neighbor(pid_s, cid_s)

        # Determine which nodes are public after base policy.
        # Also cache explicit privacy/living flags for inference guards.
        explicit_private: dict[str, bool] = {}
        explicit_living: dict[str, bool] = {}

        for pid, r in row_by_pid.items():
            (
                _pid,
                _gid,
                _name,
                _given_name,
                _surname,
                _gender,
                _birth_text,
                _death_text,
                _birth_date,
                _death_date,
                is_living_flag,
                is_private_flag,
                is_living_override,
            ) = r
            explicit_private[pid] = bool(is_private_flag)
            explicit_living[pid] = bool(is_living_override is True or is_living_flag is True)

        # Multi-source BFS from clearly-historic public anchors to infer "not living"
        # for nearby undated nodes.
        anchors: list[str] = []
        for pid, is_priv in base_private.items():
            if is_priv:
                continue
            y = year_hint_by_pid.get(pid)
            if y is not None and y <= historic_year_cutoff:
                anchors.append(pid)

        # Bound inference so we don't accidentally unredact too far.
        max_infer_hops = 3
        dist_to_historic: dict[str, int] = {}
        if anchors:
            q: list[str] = []
            for a in anchors:
                dist_to_historic[a] = 0
                q.append(a)

            qi = 0
            while qi < len(q):
                cur = q[qi]
                qi += 1
                dcur = dist_to_historic[cur]
                if dcur >= max_infer_hops:
                    continue
                for nb in neighbor_pids.get(cur, set()):
                    if nb in dist_to_historic:
                        continue
                    dist_to_historic[nb] = dcur + 1
                    q.append(nb)

        final_private: dict[str, bool] = dict(base_private)

        for pid, is_priv in base_private.items():
            if not is_priv:
                continue

            # Never override explicitly private or explicitly living.
            if explicit_private.get(pid, False) or explicit_living.get(pid, False):
                continue

            # Only attempt inference when this person has no usable year hints.
            if year_hint_by_pid.get(pid) is not None:
                continue

            d = dist_to_historic.get(pid)
            if d is not None and d <= max_infer_hops:
                final_private[pid] = False

        nodes: list[dict[str, Any]] = []
        for pid, r in row_by_pid.items():
            dist = distances.get(pid)
            if final_private.get(pid, True):
                (
                    _pid,
                    gid,
                    _name,
                    _given_name,
                    _surname,
                    _gender,
                    _birth_text,
                    _death_text,
                    _birth_date,
                    _death_date,
                    _is_living_flag,
                    _is_private_flag,
                    _is_living_override,
                ) = r
                nodes.append(
                    {
                        "id": pid,
                        "gramps_id": gid,
                        "type": "person",
                        "display_name": "Private",
                        "given_name": None,
                        "surname": None,
                        "gender": None,
                        "birth": None,
                        "death": None,
                        "distance": dist,
                    }
                )
            else:
                nodes.append(_person_node_row_to_public(r, distance=dist))

        person_node_ids = {n["id"] for n in nodes}

        edges: list[dict[str, Any]] = []

        if layout == "family":
            fam_rows = conn.execute(
                """
                SELECT DISTINCT f.id, f.gramps_id, f.father_id, f.mother_id, f.is_private
                FROM family f
                LEFT JOIN family_child fc ON fc.family_id = f.id
                WHERE f.father_id = ANY(%s)
                   OR f.mother_id = ANY(%s)
                   OR fc.child_id = ANY(%s)
                """.strip(),
                (person_ids, person_ids, person_ids),
            ).fetchall()

            family_ids: list[str] = []
            for fid, fgid, father_id, mother_id, is_private_flag in fam_rows:
                # Filter out "ghost" families: families with no parents.
                # These can be left behind by Gramps merges and only contain a child link,
                # which creates confusing bare hubs and duplicate parent connections.
                if not father_id and not mother_id:
                    continue
                family_ids.append(fid)
                parents_total = int(bool(father_id)) + int(bool(mother_id))
                nodes.append(
                    {
                        "id": fid,
                        "gramps_id": fgid,
                        "type": "family",
                        "is_private": bool(is_private_flag),
                        "parents_total": parents_total,
                        # Total children recorded for this family.
                        # Used by the UI to show an accurate "expand children" affordance.
                        "children_total": None,
                        # True when this family has children outside the current neighborhood cutoff.
                        "has_more_children": None,
                    }
                )

            family_node_ids = set(family_ids)
            node_ids = person_node_ids | family_node_ids

            # Attach marriage date metadata for non-private families.
            family_ids_public = [str(fid) for fid in family_ids if fid is not None]
            marriage_by_family = _fetch_family_marriage_date_map(conn, family_ids_public)
            for n in nodes:
                if n.get("type") != "family" or bool(n.get("is_private")):
                    continue
                mv = marriage_by_family.get(str(n.get("id")))
                if mv:
                    n["marriage"] = mv

            # Add family-child edges and count children.
            children_total_by_family: dict[str, int] = {}
            if family_ids:
                counts = conn.execute(
                    """
                    SELECT family_id, COUNT(*)
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    GROUP BY family_id
                    """.strip(),
                    (family_ids,),
                ).fetchall()
                children_total_by_family = {fid2: int(cnt or 0) for (fid2, cnt) in counts}

                fc_rows = conn.execute(
                    """
                    SELECT family_id, child_id
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    """.strip(),
                    (family_ids,),
                ).fetchall()
                for family_id, child_id in fc_rows:
                    # child edges are family -> person
                    if family_id in family_node_ids and child_id in person_node_ids:
                        edges.append({"from": family_id, "to": child_id, "type": "child"})

            # Parent edges
            for fid, fgid, father_id, mother_id, is_private_flag in fam_rows:
                if not father_id and not mother_id:
                    continue
                if fid not in family_node_ids:
                    continue
                if father_id in person_node_ids:
                    edges.append({"from": father_id, "to": fid, "type": "parent", "role": "father"})
                if mother_id in person_node_ids:
                    edges.append({"from": mother_id, "to": fid, "type": "parent", "role": "mother"})

            # Mark has_more_children based on cutoff.
            for n in nodes:
                if n.get("type") != "family":
                    continue
                fid = n.get("id")
                if not fid:
                    continue
                total = int(children_total_by_family.get(fid, 0))
                n["children_total"] = total
                # If any child is not in node_ids, then we have more children than displayed.
                if total > 0:
                    shown_children = 0
                    # We can estimate via edges we added.
                    for e in edges:
                        if e.get("type") == "child" and e.get("from") == fid:
                            shown_children += 1
                    n["has_more_children"] = bool(total > shown_children)
                else:
                    n["has_more_children"] = False

        else:
            # direct layout: parent edges derived from person_parent
            pe_rows = conn.execute(
                """
                SELECT child_id, parent_id
                FROM person_parent
                WHERE child_id = ANY(%s) AND parent_id = ANY(%s)
                """.strip(),
                (person_ids, person_ids),
            ).fetchall()
            for child_id, parent_id in pe_rows:
                edges.append({"from": parent_id, "to": child_id, "type": "parent"})

            # spouse/partner edges derived from families (regardless of marriage event)
            sp_rows = conn.execute(
                """
                SELECT father_id, mother_id
                FROM family
                WHERE father_id IS NOT NULL AND mother_id IS NOT NULL
                  AND father_id = ANY(%s) AND mother_id = ANY(%s)
                """.strip(),
                (person_ids, person_ids),
            ).fetchall()
            for father_id, mother_id in sp_rows:
                edges.append({"from": father_id, "to": mother_id, "type": "partner"})

    return {
        "root": id,
        "layout": layout,
        "depth": depth,
        "max_nodes": max_nodes,
        "nodes": nodes,
        "edges": edges,
    }


@router.get("/graph/family/parents")
def graph_family_parents(
    family_id: str = Query(min_length=1, max_length=64),
    child_id: Optional[str] = Query(default=None, max_length=64),
) -> dict[str, Any]:
    """Fetch just the parent couple for a family hub.

    Intended for UI "expand" actions where the graph already contains the family hub
    (via a child edge) but the parents are outside the current neighborhood cutoff.
    """

    with db_conn() as conn:
        fam = conn.execute(
            """
            SELECT id, gramps_id, father_id, mother_id, is_private
            FROM family
            WHERE id = %s OR gramps_id = %s
            LIMIT 1
            """.strip(),
            (family_id, family_id),
        ).fetchone()

        if not fam:
            raise HTTPException(status_code=404, detail=f"family not found: {family_id}")

        fid, fgid, father_id, mother_id, is_private_flag = tuple(fam)

        # Ghost family: nothing meaningful to expand.
        if not father_id and not mother_id:
            raise HTTPException(status_code=404, detail="family has no parents")

        parent_ids = [pid for pid in (father_id, mother_id) if pid]

        # Determine whether this family has more children than we are returning.
        total_children = conn.execute(
            "SELECT COUNT(*) FROM family_child WHERE family_id = %s",
            (fid,),
        ).fetchone()[0]
        total_children_int = int(total_children or 0)

        nodes: list[dict[str, Any]] = [
            {
                "id": fid,
                "gramps_id": fgid,
                "type": "family",
                "is_private": bool(is_private_flag),
                "parents_total": int(bool(father_id)) + int(bool(mother_id)),
                # If we only attach the single expanded child edge, indicate that more children exist.
                "has_more_children": bool(child_id and total_children_int > 1),
                "children_total": total_children_int,
            }
        ]

        if not bool(is_private_flag):
            mv = _fetch_family_marriage_date_map(conn, [fid]).get(str(fid))
            if mv:
                nodes[0]["marriage"] = mv

        birth_links: list[tuple[str, str]] = []

        if parent_ids:
            rows = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname, gender,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (parent_ids,),
            ).fetchall()
            for r in rows:
                nodes.append(_person_node_row_to_public(tuple(r), distance=None))

            # Also include each parent's own parent-family hub as a *stub* (family + child edge only).
            birth_links = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE child_id = ANY(%s)
                """.strip(),
                (parent_ids,),
            ).fetchall()

            birth_family_ids = sorted({fid for (fid, _cid) in birth_links if fid})
            if birth_family_ids:
                fam2_rows = conn.execute(
                    """
                    SELECT id, gramps_id, father_id, mother_id, is_private
                    FROM family
                    WHERE id = ANY(%s)
                    """.strip(),
                    (birth_family_ids,),
                ).fetchall()

                counts2 = conn.execute(
                    """
                    SELECT family_id, COUNT(*)
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    GROUP BY family_id
                    """.strip(),
                    (birth_family_ids,),
                ).fetchall()
                children_total_by_family2 = {fid3: int(cnt or 0) for (fid3, cnt) in counts2}

                for bf_id, bf_gid, bf_father_id, bf_mother_id, bf_private in fam2_rows:
                    # Filter out ghost families when returning stubs.
                    if not bf_father_id and not bf_mother_id:
                        continue
                    nodes.append(
                        {
                            "id": bf_id,
                            "gramps_id": bf_gid,
                            "type": "family",
                            "is_private": bool(bf_private),
                            "parents_total": int(bool(bf_father_id)) + int(bool(bf_mother_id)),
                            "children_total": int(children_total_by_family2.get(bf_id, 0)),
                            # These are returned as stubs (no parent edges), so any children imply expandable.
                            "has_more_children": bool(children_total_by_family2.get(bf_id, 0) > 0),
                        }
                    )

                # Attach marriage date metadata for non-private stub families.
                public_birth_families = [
                    str(n.get("id"))
                    for n in nodes
                    if n.get("type") == "family" and not bool(n.get("is_private"))
                ]
                marriage_by_family2 = _fetch_family_marriage_date_map(conn, public_birth_families)
                for n in nodes:
                    if n.get("type") != "family" or bool(n.get("is_private")):
                        continue
                    mv2 = marriage_by_family2.get(str(n.get("id")))
                    if mv2:
                        n["marriage"] = mv2

        edges: list[dict[str, Any]] = []
        if father_id:
            edges.append({"from": father_id, "to": fid, "type": "parent", "role": "father"})
        if mother_id:
            edges.append({"from": mother_id, "to": fid, "type": "parent", "role": "mother"})

        if child_id:
            fc_rows = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = %s AND child_id = %s
                """.strip(),
                (fid, child_id),
            ).fetchall()
            for family_id2, child_id2 in fc_rows:
                if family_id2 and child_id2:
                    edges.append({"from": family_id2, "to": child_id2, "type": "child"})

        # Stub edges for each parent's own birth family (family -> parent).
        for bf_id, child_id2 in (birth_links or []):
            if bf_id and child_id2:
                edges.append({"from": bf_id, "to": child_id2, "type": "child"})

    return {
        "family_id": family_id,
        "family": fid,
        "nodes": nodes,
        "edges": edges,
    }


@router.get("/graph/family/children")
def graph_family_children(
    family_id: str = Query(min_length=1, max_length=64),
    include_spouses: bool = True,
) -> dict[str, Any]:
    """Fetch the children for a family hub, optionally including each child's spouse block.

    Used for UI "expand down" actions.
    - Always returns the family node and its family->child edges.
    - Returns child person nodes.
    - If include_spouses: also returns (child as parent) families + spouse nodes + parent edges,
      but does not include grandchildren by default (keeps expansions controlled).
    """

    with db_conn() as conn:
        fam = conn.execute(
            """
            SELECT id, gramps_id, father_id, mother_id, is_private
            FROM family
            WHERE id = %s OR gramps_id = %s
            LIMIT 1
            """.strip(),
            (family_id, family_id),
        ).fetchone()
        if not fam:
            raise HTTPException(status_code=404, detail=f"family not found: {family_id}")

        fid, fgid, father_id, mother_id, is_private_flag = tuple(fam)

        total_children = conn.execute(
            "SELECT COUNT(*) FROM family_child WHERE family_id = %s",
            (fid,),
        ).fetchone()[0]
        total_children_int = int(total_children or 0)

        nodes: list[dict[str, Any]] = [
            {
                "id": fid,
                "gramps_id": fgid,
                "type": "family",
                "is_private": bool(is_private_flag),
                "parents_total": int(bool(father_id)) + int(bool(mother_id)),
                "has_more_children": False,
                "children_total": total_children_int,
            }
        ]

        if not bool(is_private_flag):
            mv = _fetch_family_marriage_date_map(conn, [fid]).get(str(fid))
            if mv:
                nodes[0]["marriage"] = mv

        edges: list[dict[str, Any]] = []
        if father_id:
            edges.append({"from": father_id, "to": fid, "type": "parent", "role": "father"})
        if mother_id:
            edges.append({"from": mother_id, "to": fid, "type": "parent", "role": "mother"})

        fc_rows = conn.execute(
            """
            SELECT child_id
            FROM family_child
            WHERE family_id = %s
            """.strip(),
            (fid,),
        ).fetchall()
        child_ids = [r[0] for r in fc_rows if r and r[0]]

        for cid in child_ids:
            edges.append({"from": fid, "to": cid, "type": "child"})

        if child_ids:
            child_rows = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname, gender,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (child_ids,),
            ).fetchall()
            for r in child_rows:
                nodes.append(_person_node_row_to_public(tuple(r), distance=None))

        if include_spouses and child_ids:
            fam_rows = conn.execute(
                """
                SELECT id, gramps_id, father_id, mother_id, is_private
                FROM family
                WHERE father_id IS NOT NULL
                  AND mother_id IS NOT NULL
                  AND (father_id = ANY(%s) OR mother_id = ANY(%s))
                """.strip(),
                (child_ids, child_ids),
            ).fetchall()

            spouse_person_ids: set[str] = set()
            spouse_family_ids: set[str] = set()
            for fid2, fgid2, fa2, mo2, priv2 in fam_rows:
                spouse_family_ids.add(fid2)
                nodes.append(
                    {
                        "id": fid2,
                        "gramps_id": fgid2,
                        "type": "family",
                        "is_private": bool(priv2),
                        "parents_total": int(bool(fa2)) + int(bool(mo2)),
                    }
                )
                if fa2:
                    edges.append({"from": fa2, "to": fid2, "type": "parent", "role": "father"})
                    spouse_person_ids.add(fa2)
                if mo2:
                    edges.append({"from": mo2, "to": fid2, "type": "parent", "role": "mother"})
                    spouse_person_ids.add(mo2)

            if spouse_person_ids:
                spouse_rows = conn.execute(
                    """
                    SELECT id, gramps_id, display_name, given_name, surname, gender,
                           birth_text, death_text, birth_date, death_date,
                           is_living, is_private, is_living_override
                    FROM person
                    WHERE id = ANY(%s)
                    """.strip(),
                    (list(spouse_person_ids),),
                ).fetchall()
                for r in spouse_rows:
                    nodes.append(_person_node_row_to_public(tuple(r), distance=None))

            if spouse_family_ids:
                counts = conn.execute(
                    """
                    SELECT family_id, COUNT(*)
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    GROUP BY family_id
                    """.strip(),
                    (list(spouse_family_ids),),
                ).fetchall()
                counts_by_family = {fid3: int(cnt or 0) for (fid3, cnt) in counts}
                for n in nodes:
                    if n.get("type") != "family":
                        continue
                    fid3 = n.get("id")
                    if fid3 in spouse_family_ids:
                        n["children_total"] = int(counts_by_family.get(fid3, 0))
                        n["has_more_children"] = bool(counts_by_family.get(fid3, 0) > 0)

            public_family_ids = [
                str(n.get("id")) for n in nodes if n.get("type") == "family" and not bool(n.get("is_private"))
            ]
            marriage_by_family3 = _fetch_family_marriage_date_map(conn, public_family_ids)
            for n in nodes:
                if n.get("type") != "family" or bool(n.get("is_private")):
                    continue
                mv3 = marriage_by_family3.get(str(n.get("id")))
                if mv3:
                    n["marriage"] = mv3

    return {
        "family_id": family_id,
        "family": fid,
        "nodes": nodes,
        "edges": edges,
    }
