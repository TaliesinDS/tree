"""Media endpoints: list, detail, file serving, person media, portrait override."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

try:
    from ..db import db_conn
    from ..privacy import _is_effectively_private
except ImportError:  # pragma: no cover
    from db import db_conn
    from privacy import _is_effectively_private

router = APIRouter()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slug(request: Request) -> str | None:
    return getattr(request.state, "instance_slug", None)


def _enforce_guest_privacy(request: Request, privacy: str) -> str:
    user = getattr(request.state, "user", None)
    if user and user.get("role") == "guest" and privacy.lower() == "off":
        return "on"
    return privacy


def _media_dir(instance_slug: str | None) -> Path:
    api_dir = Path(__file__).resolve().parent.parent
    slug = instance_slug or "default"
    return api_dir / "media" / slug


def _has_table(conn, table_name: str) -> bool:
    """Check if a table exists in the current search_path."""
    try:
        row = conn.execute(
            """
            SELECT 1 FROM information_schema.tables
            WHERE table_name = %s
            LIMIT 1
            """.strip(),
            (table_name,),
        ).fetchone()
        return bool(row)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# GET /media — paginated list of all media
# ---------------------------------------------------------------------------

@router.get("/media")
def list_media(
    request: Request,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None, max_length=200),
    mime: Optional[str] = Query(default=None, max_length=100),
    person_id: Optional[str] = Query(default=None, max_length=64),
    sort: str = Query(default="gramps_id_asc"),
    privacy: str = "on",
) -> dict[str, Any]:
    privacy = _enforce_guest_privacy(request, privacy)
    slug = _slug(request)
    skip_privacy = privacy.lower() == "off"

    with db_conn(slug) as conn:
        if not _has_table(conn, "media"):
            return {"offset": offset, "limit": limit, "total": 0, "results": []}

        # Build query dynamically
        where_parts: list[str] = []
        params: list[Any] = []

        if not skip_privacy:
            where_parts.append("m.is_private = FALSE")

        if q:
            where_parts.append("m.description ILIKE %s")
            params.append(f"%{q}%")

        if mime:
            if mime.endswith("/"):
                where_parts.append("m.mime LIKE %s")
                params.append(f"{mime}%")
            else:
                where_parts.append("m.mime = %s")
                params.append(mime)

        join_clause = ""
        if person_id:
            join_clause = "JOIN person_media pm_filter ON pm_filter.media_id = m.id"
            where_parts.append("pm_filter.person_id = %s")
            params.append(person_id)

        where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

        sort_map = {
            "gramps_id_asc": "m.gramps_id ASC NULLS LAST",
            "gramps_id_desc": "m.gramps_id DESC NULLS LAST",
            "description_asc": "m.description ASC NULLS LAST",
            "description_desc": "m.description DESC NULLS LAST",
            "file_size_asc": "m.file_size ASC NULLS LAST",
            "file_size_desc": "m.file_size DESC NULLS LAST",
        }
        order_sql = sort_map.get(sort, "m.gramps_id ASC NULLS LAST")

        # Total count
        count_sql = f"SELECT COUNT(DISTINCT m.id) FROM media m {join_clause} {where_sql}"
        total = conn.execute(count_sql, params).fetchone()[0]

        # Results
        data_sql = f"""
            SELECT DISTINCT m.id, m.gramps_id, m.mime, m.description,
                   m.file_size, m.width, m.height
            FROM media m
            {join_clause}
            {where_sql}
            ORDER BY {order_sql}
            LIMIT %s OFFSET %s
        """
        rows = conn.execute(data_sql, params + [limit, offset]).fetchall()

        # Get reference counts for each media
        media_ids = [r[0] for r in rows]
        ref_counts: dict[str, dict[str, int]] = {}
        if media_ids:
            for table, entity in [
                ("person_media", "persons"),
                ("event_media", "events"),
                ("place_media", "places"),
            ]:
                try:
                    ref_rows = conn.execute(
                        f"""
                        SELECT media_id, COUNT(*) FROM {table}
                        WHERE media_id = ANY(%s)
                        GROUP BY media_id
                        """.strip(),
                        (media_ids,),
                    ).fetchall()
                    for mid, cnt in ref_rows:
                        ref_counts.setdefault(mid, {"persons": 0, "events": 0, "places": 0})
                        ref_counts[mid][entity] = int(cnt)
                except Exception:
                    pass

        results = []
        for r in rows:
            mid, gid, mime_type, desc, fsize, w, h = r
            results.append({
                "id": mid,
                "gramps_id": gid,
                "mime": mime_type,
                "description": desc,
                "thumb_url": f"/media/file/thumb/{mid}.png",
                "width": w,
                "height": h,
                "file_size": fsize,
                "references": ref_counts.get(mid, {"persons": 0, "events": 0, "places": 0}),
            })

    return {
        "offset": offset,
        "limit": limit,
        "total": int(total),
        "results": results,
    }


# ---------------------------------------------------------------------------
# GET /media/{media_id} — single media detail with all references
# ---------------------------------------------------------------------------

@router.get("/media/{media_id}")
def get_media_detail(
    media_id: str,
    request: Request,
    privacy: str = "on",
) -> dict[str, Any]:
    privacy = _enforce_guest_privacy(request, privacy)
    slug = _slug(request)
    skip_privacy = privacy.lower() == "off"

    with db_conn(slug) as conn:
        if not _has_table(conn, "media"):
            raise HTTPException(status_code=404, detail="media not found")

        row = conn.execute(
            """
            SELECT id, gramps_id, mime, description, checksum,
                   original_path, file_size, width, height, is_private
            FROM media WHERE id = %s
            """.strip(),
            (media_id,),
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="media not found")

        mid, gid, mime_type, desc, checksum, orig_path, fsize, w, h, is_private = row

        if bool(is_private) and not skip_privacy:
            raise HTTPException(status_code=403, detail="private media")

        # Determine file extension for original URL
        ext = ".jpg"
        if mime_type:
            ext_map = {
                "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                "image/svg+xml": ".svg", "image/webp": ".webp",
            }
            ext = ext_map.get(mime_type.lower(), ".jpg")

        # Fetch references
        persons: list[dict[str, Any]] = []
        try:
            p_rows = conn.execute(
                """
                SELECT pm.person_id, p.gramps_id, p.display_name,
                       p.is_living, p.is_private, p.is_living_override,
                       p.birth_date, p.death_date
                FROM person_media pm
                JOIN person p ON p.id = pm.person_id
                WHERE pm.media_id = %s
                ORDER BY pm.sort_order
                """.strip(),
                (media_id,),
            ).fetchall()
            for pr in p_rows:
                pid, pgid, pname, is_living, is_priv, is_lo, bd, dd = pr
                if not skip_privacy and _is_effectively_private(
                    is_private=is_priv,
                    is_living_override=is_lo,
                    is_living=is_living,
                    birth_date=bd,
                    death_date=dd,
                ):
                    continue
                persons.append({"id": pid, "gramps_id": pgid, "display_name": pname})
        except Exception:
            pass

        events: list[dict[str, Any]] = []
        try:
            e_rows = conn.execute(
                """
                SELECT em.event_id, e.gramps_id, e.event_type, e.description
                FROM event_media em
                JOIN event e ON e.id = em.event_id
                WHERE em.media_id = %s AND e.is_private = FALSE
                ORDER BY em.sort_order
                """.strip(),
                (media_id,),
            ).fetchall()
            for er in e_rows:
                eid, egid, etype, edesc = er
                events.append({"id": eid, "gramps_id": egid, "type": etype, "description": edesc})
        except Exception:
            pass

        places: list[dict[str, Any]] = []
        try:
            pl_rows = conn.execute(
                """
                SELECT plm.place_id, pl.gramps_id, pl.name
                FROM place_media plm
                JOIN place pl ON pl.id = plm.place_id
                WHERE plm.media_id = %s AND pl.is_private = FALSE
                ORDER BY plm.sort_order
                """.strip(),
                (media_id,),
            ).fetchall()
            for plr in pl_rows:
                plid, plgid, plname = plr
                places.append({"id": plid, "gramps_id": plgid, "name": plname})
        except Exception:
            pass

    return {
        "id": mid,
        "gramps_id": gid,
        "mime": mime_type,
        "description": desc,
        "checksum": checksum,
        "original_path": orig_path,
        "file_size": fsize,
        "width": w,
        "height": h,
        "thumb_url": f"/media/file/thumb/{mid}.png",
        "original_url": f"/media/file/original/{mid}{ext}",
        "references": {
            "persons": persons,
            "events": events,
            "places": places,
        },
    }


# ---------------------------------------------------------------------------
# GET /media/file/thumb/{filename} — serve thumbnail
# GET /media/file/original/{filename} — serve original
# ---------------------------------------------------------------------------

@router.get("/media/file/thumb/{filename}")
def serve_thumb(filename: str, request: Request, privacy: str = "on"):
    slug = _slug(request)
    privacy = _enforce_guest_privacy(request, privacy)
    # Extract handle from filename (strip extension)
    handle = filename.rsplit(".", 1)[0] if "." in filename else filename

    media_root = _media_dir(slug)
    thumb_path = media_root / "thumb" / filename

    if not thumb_path.exists():
        # Try with .png (current format)
        thumb_path = media_root / "thumb" / f"{handle}.png"
    if not thumb_path.exists():
        # Fallback to legacy .jpg
        thumb_path = media_root / "thumb" / f"{handle}.jpg"
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="thumbnail not found")

    # Privacy check
    if privacy.lower() != "off":
        with db_conn(slug) as conn:
            if _has_table(conn, "media"):
                row = conn.execute(
                    "SELECT is_private FROM media WHERE id = %s", (handle,)
                ).fetchone()
                if row and bool(row[0]):
                    raise HTTPException(status_code=403, detail="private media")

    # Detect content type from file extension
    ct = "image/png" if thumb_path.suffix == ".png" else "image/jpeg"
    return FileResponse(
        str(thumb_path),
        media_type=ct,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/media/file/original/{filename}")
def serve_original(filename: str, request: Request, privacy: str = "on"):
    slug = _slug(request)
    privacy = _enforce_guest_privacy(request, privacy)
    handle = filename.rsplit(".", 1)[0] if "." in filename else filename

    media_root = _media_dir(slug)
    orig_dir = media_root / "original"

    # Find the file (handle + any extension)
    target = None
    if orig_dir.exists():
        for f in orig_dir.iterdir():
            if f.stem == handle:
                target = f
                break

    if not target or not target.exists():
        raise HTTPException(status_code=404, detail="original file not found")

    # Privacy check
    if privacy.lower() != "off":
        with db_conn(slug) as conn:
            if _has_table(conn, "media"):
                row = conn.execute(
                    "SELECT is_private FROM media WHERE id = %s", (handle,)
                ).fetchone()
                if row and bool(row[0]):
                    raise HTTPException(status_code=403, detail="private media")

    # Map extension to MIME
    ext_mime = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    }
    mime = ext_mime.get(target.suffix.lower(), "application/octet-stream")

    return FileResponse(
        str(target),
        media_type=mime,
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ---------------------------------------------------------------------------
# GET /people/{person_id}/media — ordered media for a person
# ---------------------------------------------------------------------------

@router.get("/people/{person_id}/media")
def get_person_media(
    person_id: str,
    request: Request,
    privacy: str = "on",
) -> dict[str, Any]:
    slug = _slug(request)
    privacy = _enforce_guest_privacy(request, privacy)
    skip_privacy = privacy.lower() == "off"

    with db_conn(slug) as conn:
        if not _has_table(conn, "person_media"):
            return {"person_id": person_id, "portrait": None, "media": []}

        # Check if person is private
        if not skip_privacy:
            p_row = conn.execute(
                """
                SELECT is_living, is_private, is_living_override, birth_date, death_date
                FROM person WHERE id = %s
                """.strip(),
                (person_id,),
            ).fetchone()
            if p_row:
                is_living, is_priv, is_lo, bd, dd = p_row
                if _is_effectively_private(
                    is_private=is_priv,
                    is_living_override=is_lo,
                    is_living=is_living,
                    birth_date=bd,
                    death_date=dd,
                ):
                    return {"person_id": person_id, "portrait": None, "media": []}

        rows = conn.execute(
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
            (person_id,),
        ).fetchall()

        media = []
        portrait = None
        for r in rows:
            (mid, gid, desc, mime_type, w, h, sort_order, is_portrait,
             rx1, ry1, rx2, ry2, m_private) = r

            if bool(m_private) and not skip_privacy:
                continue

            ext = ".jpg"
            if mime_type:
                ext_map = {
                    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                    "image/svg+xml": ".svg", "image/webp": ".webp",
                }
                ext = ext_map.get(mime_type.lower(), ".jpg")

            entry = {
                "id": mid,
                "gramps_id": gid,
                "description": desc,
                "mime": mime_type,
                "thumb_url": f"/media/file/thumb/{mid}.png",
                "original_url": f"/media/file/original/{mid}{ext}",
                "width": w,
                "height": h,
                "sort_order": sort_order,
                "is_portrait": bool(is_portrait),
            }

            if rx1 is not None:
                entry["region"] = {"x1": rx1, "y1": ry1, "x2": rx2, "y2": ry2}

            media.append(entry)

            # Portrait resolution: user-chosen (is_portrait) > first media
            if bool(is_portrait):
                portrait = entry
            elif portrait is None and sort_order == 0:
                portrait = entry

    return {
        "person_id": person_id,
        "portrait": portrait,
        "media": media,
    }


# ---------------------------------------------------------------------------
# PUT /people/{person_id}/portrait — set/clear portrait override
# ---------------------------------------------------------------------------

@router.put("/people/{person_id}/portrait")
async def set_portrait(
    person_id: str,
    request: Request,
) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if user and user.get("role") == "guest":
        raise HTTPException(status_code=403, detail="guests cannot set portraits")

    body = await request.json()
    media_id = body.get("media_id")

    slug = _slug(request)
    with db_conn(slug) as conn:
        if not _has_table(conn, "person_media"):
            raise HTTPException(status_code=404, detail="media tables not available")

        # Clear all portraits for this person
        conn.execute(
            "UPDATE person_media SET is_portrait = FALSE WHERE person_id = %s",
            (person_id,),
        )

        if media_id:
            # Set the chosen one
            result = conn.execute(
                """
                UPDATE person_media SET is_portrait = TRUE
                WHERE person_id = %s AND media_id = %s
                """.strip(),
                (person_id, media_id),
            )
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="media not linked to person")

        conn.commit()

    return {"ok": True, "person_id": person_id, "media_id": media_id}


# ---------------------------------------------------------------------------
# Helper: resolve portrait URL for a person
# ---------------------------------------------------------------------------

def resolve_portrait_url(conn, person_id: str, skip_privacy: bool = False) -> str | None:
    """Return the thumbnail URL for a person's portrait, or None."""
    try:
        row = conn.execute(
            """
            SELECT pm.media_id, m.is_private
            FROM person_media pm
            JOIN media m ON m.id = pm.media_id
            WHERE pm.person_id = %s
            ORDER BY pm.is_portrait DESC, pm.sort_order ASC
            LIMIT 1
            """.strip(),
            (person_id,),
        ).fetchone()
        if not row:
            return None
        mid, m_private = row
        if bool(m_private) and not skip_privacy:
            return None
        return f"/media/file/thumb/{mid}.png"
    except Exception:
        return None
