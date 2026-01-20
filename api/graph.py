from __future__ import annotations

import psycopg


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


def _fetch_spouses(conn: psycopg.Connection, node_ids: list[str]) -> dict[str, list[str]]:
    """Return person->list(spouse/partner person_ids) for any family where they are a parent.

    Note: We treat spouse links as "same generation" (depth cost 0) and we *do not*
    expand further through spouse links during neighborhood BFS to avoid pulling in
    large lateral marriage networks.
    """

    if not node_ids:
        return {}

    out: dict[str, list[str]] = {nid: [] for nid in node_ids}

    # Spouses/partners are inferred via family rows with both parents set.
    rows = conn.execute(
        """
        SELECT father_id, mother_id
        FROM family
        WHERE father_id IS NOT NULL
          AND mother_id IS NOT NULL
          AND (father_id = ANY(%s) OR mother_id = ANY(%s))
        """.strip(),
        (node_ids, node_ids),
    ).fetchall()

    for father_id, mother_id in rows:
        if father_id in out:
            out[father_id].append(mother_id)
        if mother_id in out:
            out[mother_id].append(father_id)

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

    # Attach spouses for the root immediately (same generation; do not expand via spouse links).
    for sp in _fetch_spouses(conn, [start]).get(start, []):
        if sp in distances:
            continue
        distances[sp] = 0
        if len(distances) >= max_nodes:
            return distances

    if depth <= 0:
        return distances

    frontier = [start]
    for d in range(1, depth + 1):
        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []

        # Expand only through parent/child edges (generation distance).
        for node in frontier:
            for nb in neigh.get(node, []):
                if nb in distances:
                    continue
                distances[nb] = d
                next_frontier.append(nb)
                if len(distances) >= max_nodes:
                    return distances

        # Attach spouses for newly discovered nodes at this generation.
        if next_frontier:
            sp_map = _fetch_spouses(conn, next_frontier)
            for pid in next_frontier:
                for sp in sp_map.get(pid, []):
                    if sp in distances:
                        continue
                    distances[sp] = d
                    if len(distances) >= max_nodes:
                        return distances

        frontier = next_frontier
        if not frontier:
            break

    return distances
