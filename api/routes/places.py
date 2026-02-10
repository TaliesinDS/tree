from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Query, Request

try:
    from ..db import db_conn
    from ..util import _compact_json
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn
    from util import _compact_json

router = APIRouter()


def _slug(request: Request) -> str | None:
    return getattr(request.state, "instance_slug", None)


@router.get("/places/events_counts")
def places_events_counts(request: Request) -> dict[str, Any]:
    """Return per-place event counts (privacy-safe).

    Used by the Map tab to decide whether to show the per-place events menu.

    Notes:
    - Counts only include events where event.is_private = FALSE.
    - Only includes non-private places.
    """

    with db_conn(_slug(request)) as conn:
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


@router.get("/places")
def list_places(
    request: Request,
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

    with db_conn(_slug(request)) as conn:
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
                pid2 = rec.get("enclosed_by_id")
                if pid2:
                    to_fetch.add(str(pid2))

            depth = 0
            while to_fetch and depth < 16:
                batch = [pid2 for pid2 in to_fetch if pid2 not in by_id]
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

                for (pid3, gramps_id3, name3, place_type3, enclosed_by_id3) in anc_rows:
                    rec2 = {
                        "id": str(pid3),
                        "gramps_id": gramps_id3,
                        "name": name3,
                        "type": place_type3,
                        "enclosed_by_id": enclosed_by_id3,
                        "lat": None,
                        "lon": None,
                    }
                    by_id[rec2["id"]] = rec2

                    nxt = rec2.get("enclosed_by_id")
                    if nxt:
                        nxt = str(nxt)
                        if nxt not in by_id:
                            to_fetch.add(nxt)

                depth += 1

        # Add enclosure chain for each returned place.
        enclosure_cache: dict[str, list[dict[str, Any]]] = {}

        def _enclosure_for(pid4: str) -> list[dict[str, Any]]:
            if pid4 in enclosure_cache:
                return enclosure_cache[pid4]
            out2: list[dict[str, Any]] = []
            seen: set[str] = set()
            cur = by_id.get(pid4)
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
                out2.append(
                    {
                        "id": parent.get("id"),
                        "gramps_id": parent.get("gramps_id"),
                        "name": parent.get("name"),
                        "type": parent.get("type"),
                    }
                )
                cur = parent
            enclosure_cache[pid4] = out2
            return out2

        for rec in results:
            rec["enclosure"] = _enclosure_for(rec["id"])

    return _compact_json({"offset": offset, "limit": limit, "results": results}) or {
        "offset": offset,
        "limit": limit,
        "results": results,
    }


@router.get("/places/{place_id}")
def get_place(place_id: str, request: Request) -> dict[str, Any]:
    # Placeholder.
    return {
        "id": place_id,
        "name": f"Place {place_id}",
        "lat": None,
        "lon": None,
    }
