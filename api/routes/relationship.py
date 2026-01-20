from __future__ import annotations

from typing import Any

import psycopg
from fastapi import APIRouter, HTTPException, Query

try:
    from ..db import db_conn
    from ..graph import _fetch_neighbors
    from ..names import _smart_title_case_name
    from ..privacy import _is_effectively_private
    from ..resolve import _resolve_person_id
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn
    from graph import _fetch_neighbors
    from names import _smart_title_case_name
    from privacy import _is_effectively_private
    from resolve import _resolve_person_id

router = APIRouter()


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


@router.get("/relationship/path")
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
