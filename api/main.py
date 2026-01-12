from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any, Literal

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

try:
    from .db import db_conn
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn

app = FastAPI(title="Genealogy API", version="0.0.1")


_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


@app.get("/static/graph_demo.htm", include_in_schema=False)
def _static_graph_demo_htm_redirect() -> RedirectResponse:
    # Common typo/missing 'l'. Keep old links working.
    return RedirectResponse(url="/static/graph_demo.html", status_code=307)


@app.get("/demo/graph")
def demo_graph() -> FileResponse:
    """Interactive Cytoscape demo for the /graph/neighborhood endpoint."""

    path = _STATIC_DIR / "graph_demo.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="demo not found")
    return FileResponse(path)


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


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


@app.get("/people/{person_id}")
def get_person(person_id: str) -> dict[str, Any]:
    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")

    resolved_id = _resolve_person_id(person_id)

    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname, gender,
                   birth_text, death_text, is_living, is_private
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
        is_living_flag,
        is_private_flag,
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

    # Enforce privacy even if upstream export forgot.
    if person.get("is_private") or person.get("is_living"):
        return {
            "id": person["id"],
            "gramps_id": person.get("gramps_id"),
            "display_name": "Private",
            "given_name": None,
            "surname": None,
            "gender": None,
            "birth": None,
            "death": None,
            "is_living": True if person.get("is_living") is None else bool(person.get("is_living")),
            "is_private": True,
        }

    return {
        "id": person["id"],
        "gramps_id": person.get("gramps_id"),
        "display_name": person.get("display_name"),
        "given_name": person.get("given_name"),
        "surname": person.get("surname"),
        "gender": person.get("gender"),
        "birth": person.get("birth_text"),
        "death": person.get("death_text"),
        "is_living": bool(person.get("is_living")) if person.get("is_living") is not None else None,
        "is_private": bool(person.get("is_private")),
    }


@app.get("/people/search")
def search_people(q: str = Query(min_length=1, max_length=200)) -> dict[str, Any]:
    q_like = f"%{q}%"
    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name, is_living, is_private
            FROM person
            WHERE display_name ILIKE %s
            ORDER BY display_name
            LIMIT 25
            """.strip(),
            (q_like,),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for r in rows:
        # Always redact living/private from search results.
        if r[3] or r[4]:
            results.append({"id": r[0], "gramps_id": r[1], "display_name": "Private"})
        else:
            results.append({"id": r[0], "gramps_id": r[1], "display_name": r[2]})

    return {"query": q, "results": results}


def _fetch_neighbors(conn: psycopg.Connection, node_ids: list[str]) -> dict[str, list[str]]:
    if not node_ids:
        return {}

    out: dict[str, list[str]] = {nid: [] for nid in node_ids}

    # Parents
    for child_id, parent_id in conn.execute(
        "SELECT child_id, parent_id FROM person_parent WHERE child_id = ANY(%s)",
        (node_ids,),
    ).fetchall():
        out.setdefault(child_id, []).append(parent_id)

    # Children
    for parent_id, child_id in conn.execute(
        "SELECT parent_id, child_id FROM person_parent WHERE parent_id = ANY(%s)",
        (node_ids,),
    ).fetchall():
        out.setdefault(parent_id, []).append(child_id)

    return out


def _bfs_neighborhood(
    conn: psycopg.Connection,
    start: str,
    *,
    depth: int,
    max_nodes: int,
) -> list[str]:
    if depth <= 0:
        return [start]

    seen: set[str] = {start}
    frontier = [start]
    for _ in range(depth):
        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []
        for node in frontier:
            for nb in neigh.get(node, []):
                if nb in seen:
                    continue
                seen.add(nb)
                next_frontier.append(nb)
                if len(seen) >= max_nodes:
                    return list(seen)
        frontier = next_frontier
        if not frontier:
            break

    return list(seen)


def _bfs_neighborhood_distances(
    conn: psycopg.Connection,
    start: str,
    *,
    depth: int,
    max_nodes: int,
) -> dict[str, int]:
    """Return node->distance for an undirected person neighborhood BFS."""

    distances: dict[str, int] = {start: 0}
    if depth <= 0:
        return distances

    frontier = [start]
    for d in range(1, depth + 1):
        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []
        for node in frontier:
            for nb in neigh.get(node, []):
                if nb in distances:
                    continue
                distances[nb] = d
                next_frontier.append(nb)
                if len(distances) >= max_nodes:
                    return distances
        frontier = next_frontier
        if not frontier:
            break

    return distances


def _person_node_row_to_public(r: tuple[Any, ...], *, distance: int | None = None) -> dict[str, Any]:
    # r = (id, gramps_id, display_name, given_name, surname, gender, birth_text, death_text, is_living, is_private)
    (
        pid,
        gid,
        name,
        given_name,
        surname,
        gender,
        birth_text,
        death_text,
        is_living_flag,
        is_private_flag,
    ) = r
    if is_living_flag or is_private_flag:
        return {
            "id": pid,
            "gramps_id": gid,
            "type": "person",
            "display_name": "Private",
            "given_name": None,
            "surname": None,
            "gender": None,
            "birth": None,
            "death": None,
            "distance": distance,
        }
    return {
        "id": pid,
        "gramps_id": gid,
        "type": "person",
        "display_name": name,
        "given_name": given_name,
        "surname": surname,
        "gender": gender,
        "birth": birth_text,
        "death": death_text,
        "distance": distance,
    }


@app.get("/graph/neighborhood")
def graph_neighborhood(
    id: str = Query(min_length=1, max_length=64),
    depth: int = Query(default=2, ge=0, le=12),
    max_nodes: int = Query(default=1000, ge=1, le=5000),
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

        # Include partners (spouses) via family membership so a "parents + children" view
        # doesn't randomly omit the other parent.
        person_id_set = set(person_ids)
        spouse_pairs = conn.execute(
            """
            SELECT DISTINCT father_id, mother_id
            FROM family
            WHERE (father_id = ANY(%s) OR mother_id = ANY(%s))
              AND father_id IS NOT NULL
              AND mother_id IS NOT NULL
            """.strip(),
            (person_ids, person_ids),
        ).fetchall()
        for father_id, mother_id in spouse_pairs:
            if father_id:
                person_id_set.add(father_id)
            if mother_id:
                person_id_set.add(mother_id)
            if len(person_id_set) >= max_nodes:
                break

        person_ids = list(person_id_set)

        person_rows = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname, gender,
                   birth_text, death_text, is_living, is_private
            FROM person
            WHERE id = ANY(%s)
            """.strip(),
            (person_ids,),
        ).fetchall()
        nodes: list[dict[str, Any]] = [
            _person_node_row_to_public(tuple(r), distance=distances.get(r[0])) for r in person_rows
        ]
        node_ids = {n["id"] for n in nodes}

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
                family_ids.append(fid)
                nodes.append(
                    {
                        "id": fid,
                        "gramps_id": fgid,
                        "type": "family",
                        "is_private": bool(is_private_flag),
                    }
                )

                if father_id and father_id in node_ids:
                    edges.append(
                        {"from": father_id, "to": fid, "type": "parent", "role": "father"}
                    )
                if mother_id and mother_id in node_ids:
                    edges.append(
                        {"from": mother_id, "to": fid, "type": "parent", "role": "mother"}
                    )

            if family_ids:
                fc_rows = conn.execute(
                    """
                    SELECT family_id, child_id
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    """.strip(),
                    (family_ids,),
                ).fetchall()
                for family_id, child_id in fc_rows:
                    if child_id in node_ids:
                        edges.append({"from": family_id, "to": child_id, "type": "child"})

        else:
            # parent edges
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
            SELECT id, gramps_id, display_name, is_living, is_private
            FROM person
            WHERE id = ANY(%s)
            """.strip(),
            (path_ids,),
        ).fetchall()
        by_id = {
            r[0]: {
                "id": r[0],
                "gramps_id": r[1],
                "display_name": ("Private" if (r[3] or r[4]) else r[2]),
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


def is_living(birth: date | None, death: date | None, living_cutoff_years: int = 110) -> bool:
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
