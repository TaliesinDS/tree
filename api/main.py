from __future__ import annotations

from datetime import date
from pathlib import Path
import re
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


_PRIVACY_BORN_ON_OR_AFTER = date(1946, 1, 1)
_PRIVACY_AGE_CUTOFF_YEARS = 90

_PAREN_EPITHET_RE = re.compile(r"^\([^()]{1,80}\)$")


def _normalize_public_name_fields(
    *,
    display_name: str | None,
    given_name: str | None,
    surname: str | None,
) -> tuple[str | None, str | None]:
    """Normalize name fields for public/UI use.

    Gramps sometimes stores epithets like "(dragon)" inside the given name.
    If they drift into the surname column (exports/imports can be messy), we treat
    parenthetical-only surnames as an epithet and keep it in the given name.
    """

    s = (surname or "").strip()
    if not s:
        return given_name, surname

    if _PAREN_EPITHET_RE.match(s):
        dn = (display_name or "").strip()
        g = (given_name or "").strip()
        if dn:
            return dn, None
        if g:
            return f"{g} {s}".strip(), None
        return s, None

    return given_name, surname


def _add_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        # Handle Feb 29 -> Feb 28 in non-leap years.
        return d.replace(month=2, day=28, year=d.year + years)


def _is_younger_than(birth: date, years: int, *, today: date | None = None) -> bool:
    t = today or date.today()
    return t < _add_years(birth, years)


def _is_effectively_living(
    *,
    is_living_override: bool | None,
    is_living: bool | None,
    death_date: date | None,
) -> bool | None:
    if is_living_override is not None:
        return bool(is_living_override)
    if is_living is not None:
        return bool(is_living)
    if death_date is not None:
        return False
    return None


def _is_effectively_private(
    *,
    is_private: bool | None,
    is_living_override: bool | None,
    is_living: bool | None,
    birth_date: date | None,
    death_date: date | None,
) -> bool:
    """Privacy policy:

    - Explicitly private => private
    - If (effectively) living:
      - born >= 1946-01-01 => private
      - else if age < 90 => private
      - else public
    - Unknown birth date: privacy-first => private (for living/unknown living)
    """

    if bool(is_private):
        return True

    living = _is_effectively_living(
        is_living_override=is_living_override,
        is_living=is_living,
        death_date=death_date,
    )
    if living is False:
        return False

    # living is True or unknown
    if birth_date is None:
        return True
    if birth_date >= _PRIVACY_BORN_ON_OR_AFTER:
        return True
    if _is_younger_than(birth_date, _PRIVACY_AGE_CUTOFF_YEARS):
        return True
    return False


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


@app.get("/demo/viewer")
def demo_viewer() -> FileResponse:
    """Starter Gramps-Web-like viewer shell (Graph + People + Events + Map tabs)."""

    # Viewer that ports the graph demo layout (graph_demo.html is kept as reference).
    path = _STATIC_DIR / "viewer_ported.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="viewer not found")
    return FileResponse(path)


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


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
                   birth_date, death_date, is_living, is_private, is_living_override
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
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
        ) = tuple(r)

        if _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
        ):
            results.append(
                {
                    "id": pid,
                    "gramps_id": gid,
                    "type": "person",
                    "display_name": "Private",
                    "given_name": None,
                    "surname": None,
                }
            )
        else:
            given_name_out, surname_out = _normalize_public_name_fields(
                display_name=display_name,
                given_name=given_name,
                surname=surname,
            )
            results.append(
                {
                    "id": pid,
                    "gramps_id": gid,
                    "type": "person",
                    "display_name": display_name,
                    "given_name": given_name_out,
                    "surname": surname_out,
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

    should_redact = _is_effectively_private(
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

    given_name_out, surname_out = _normalize_public_name_fields(
        display_name=person.get("display_name"),
        given_name=person.get("given_name"),
        surname=person.get("surname"),
    )

    return {
        "id": person["id"],
        "gramps_id": person.get("gramps_id"),
        "display_name": person.get("display_name"),
        "given_name": given_name_out,
        "surname": surname_out,
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
        if _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
        ):
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


def _person_node_row_to_public(r: tuple[Any, ...], *, distance: int | None = None) -> dict[str, Any]:
    # r = (
    #   id, gramps_id, display_name, given_name, surname, gender,
    #   birth_text, death_text, birth_date, death_date,
    #   is_living, is_private, is_living_override
    # )
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

    if _is_effectively_private(
        is_private=is_private_flag,
        is_living_override=is_living_override,
        is_living=is_living_flag,
        birth_date=birth_date,
        death_date=death_date,
    ):
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
    given_name_out, surname_out = _normalize_public_name_fields(
        display_name=name,
        given_name=given_name,
        surname=surname,
    )

    return {
        "id": pid,
        "gramps_id": gid,
        "type": "person",
        "display_name": name,
        "given_name": given_name_out,
        "surname": surname_out,
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
                    else r[2]
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
