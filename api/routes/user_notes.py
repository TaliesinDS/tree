"""User Notes CRUD routes.

User notes are per-instance, linked by gramps_id (survives re-imports).
All authenticated users can read notes; user/admin can create/edit/delete.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

try:
    from ..auth import get_current_user, get_instance_slug
    from ..db import db_conn
except ImportError:  # pragma: no cover
    from auth import get_current_user, get_instance_slug
    from db import db_conn

router = APIRouter(prefix="/user-notes", tags=["user-notes"])


class NoteCreate(BaseModel):
    gramps_id: str
    body: str


class NoteUpdate(BaseModel):
    body: str


def _get_slug(request: Request) -> str:
    return get_instance_slug(request)


@router.get("")
def list_notes(request: Request, gramps_id: Optional[str] = None) -> dict:
    """List user notes, optionally filtered by gramps_id."""
    user = get_current_user(request)
    slug = _get_slug(request)

    with db_conn(slug) as conn:
        if gramps_id:
            rows = conn.execute(
                """
                SELECT un.id, un.gramps_id, un.user_id, u.username, u.display_name,
                       un.body, un.created_at, un.updated_at,
                       EXISTS(SELECT 1 FROM person p WHERE p.gramps_id = un.gramps_id) AS person_exists
                FROM user_note un
                JOIN _core.users u ON u.id = un.user_id
                WHERE un.gramps_id = %s
                ORDER BY un.created_at
                """,
                (gramps_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT un.id, un.gramps_id, un.user_id, u.username, u.display_name,
                       un.body, un.created_at, un.updated_at,
                       EXISTS(SELECT 1 FROM person p WHERE p.gramps_id = un.gramps_id) AS person_exists
                FROM user_note un
                JOIN _core.users u ON u.id = un.user_id
                ORDER BY un.created_at
                """,
            ).fetchall()

    results = []
    for r in rows:
        nid, gid, uid, uname, udname, body, created, updated, person_exists = r
        results.append({
            "id": nid,
            "gramps_id": gid,
            "user_id": uid,
            "username": uname,
            "user_display_name": udname,
            "body": body,
            "created_at": created.isoformat() if created else None,
            "updated_at": updated.isoformat() if updated else None,
            "orphaned": not person_exists,
        })

    return {"results": results}


@router.post("")
def create_note(body: NoteCreate, request: Request) -> dict[str, Any]:
    """Create a user note (user/admin only)."""
    user = get_current_user(request)
    if user["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot create notes")

    slug = _get_slug(request)

    with db_conn(slug) as conn:
        row = conn.execute(
            """
            INSERT INTO user_note (gramps_id, user_id, body)
            VALUES (%s, %s, %s)
            RETURNING id, created_at
            """,
            (body.gramps_id, user["id"], body.body),
        ).fetchone()
        conn.commit()

    return {
        "id": row[0],
        "gramps_id": body.gramps_id,
        "user_id": user["id"],
        "body": body.body,
        "created_at": row[1].isoformat() if row[1] else None,
    }


@router.put("/{note_id}")
def update_note(note_id: int, body: NoteUpdate, request: Request) -> dict[str, Any]:
    """Update a user note. Users can only edit their own; admins can edit any."""
    user = get_current_user(request)
    if user["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot edit notes")

    slug = _get_slug(request)

    with db_conn(slug) as conn:
        existing = conn.execute(
            "SELECT id, user_id FROM user_note WHERE id = %s", (note_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Note not found")

        if user["role"] != "admin" and existing[1] != user["id"]:
            raise HTTPException(status_code=403, detail="Cannot edit another user's note")

        conn.execute(
            "UPDATE user_note SET body = %s, updated_at = now() WHERE id = %s",
            (body.body, note_id),
        )
        conn.commit()

    return {"ok": True, "id": note_id}


@router.delete("/{note_id}")
def delete_note(note_id: int, request: Request) -> dict[str, Any]:
    """Delete a user note. Users can only delete their own; admins can delete any."""
    user = get_current_user(request)
    if user["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot delete notes")

    slug = _get_slug(request)

    with db_conn(slug) as conn:
        existing = conn.execute(
            "SELECT id, user_id FROM user_note WHERE id = %s", (note_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Note not found")

        if user["role"] != "admin" and existing[1] != user["id"]:
            raise HTTPException(status_code=403, detail="Cannot delete another user's note")

        conn.execute("DELETE FROM user_note WHERE id = %s", (note_id,))
        conn.commit()

    return {"ok": True}


@router.get("/export")
def export_notes(
    request: Request,
    gramps_ids: Optional[str] = None,
    format: str = "json",
) -> dict:
    """Export user notes as JSON (user/admin only)."""
    user = get_current_user(request)
    if user["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot export notes")

    slug = _get_slug(request)

    with db_conn(slug) as conn:
        if gramps_ids:
            id_list = [g.strip() for g in gramps_ids.split(",") if g.strip()]
            rows = conn.execute(
                """
                SELECT un.id, un.gramps_id, u.username, un.body, un.created_at, un.updated_at
                FROM user_note un
                JOIN _core.users u ON u.id = un.user_id
                WHERE un.gramps_id = ANY(%s)
                ORDER BY un.gramps_id, un.created_at
                """,
                (id_list,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT un.id, un.gramps_id, u.username, un.body, un.created_at, un.updated_at
                FROM user_note un
                JOIN _core.users u ON u.id = un.user_id
                ORDER BY un.gramps_id, un.created_at
                """,
            ).fetchall()

    results = []
    for nid, gid, uname, body, created, updated in rows:
        results.append({
            "id": nid,
            "gramps_id": gid,
            "author": uname,
            "body": body,
            "created_at": created.isoformat() if created else None,
            "updated_at": updated.isoformat() if updated else None,
        })

    return {"notes": results, "total": len(results)}
