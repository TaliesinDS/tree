"""Instance member (guest) management routes.

Users and admins can create/list/delete guest accounts for their instance.
Admins can also manage user-level accounts.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

try:
    from ..auth import get_current_user, hash_password, validate_password
    from ..db import db_conn
except ImportError:  # pragma: no cover
    from auth import get_current_user, hash_password, validate_password
    from db import db_conn

router = APIRouter(tags=["members"])


class CreateGuestRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None


@router.post("/instances/{slug}/guests")
def create_guest(slug: str, body: CreateGuestRequest, request: Request) -> dict[str, Any]:
    """Create a guest account for the given instance (user/admin only)."""
    user = get_current_user(request)
    if user["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot create accounts")

    # Non-admin users can only manage their own instance.
    if user["role"] != "admin":
        user_slug = getattr(request.state, "instance_slug", None)
        if user_slug != slug:
            raise HTTPException(status_code=403, detail="Cannot manage other instances")

    # Validate password strength.
    pw_error = validate_password(body.password)
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

    pw_hash = hash_password(body.password)

    with db_conn() as conn:
        # Check instance exists.
        inst = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (slug,)
        ).fetchone()
        if not inst:
            raise HTTPException(status_code=404, detail="Instance not found")

        # Check username uniqueness.
        existing = conn.execute(
            "SELECT id FROM _core.users WHERE username = %s", (body.username,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username already taken")

        # Create user.
        row = conn.execute(
            """
            INSERT INTO _core.users (username, display_name, password_hash, role)
            VALUES (%s, %s, %s, 'guest')
            RETURNING id
            """,
            (body.username, body.display_name or body.username, pw_hash),
        ).fetchone()
        new_user_id = row[0]

        # Create membership.
        conn.execute(
            """
            INSERT INTO _core.memberships (user_id, instance_id, role)
            VALUES (%s, %s, 'guest')
            """,
            (new_user_id, inst[0]),
        )
        conn.commit()

    return {
        "ok": True,
        "user_id": new_user_id,
        "username": body.username,
        "role": "guest",
        "instance": slug,
    }


@router.get("/instances/{slug}/guests")
def list_guests(slug: str, request: Request) -> dict[str, Any]:
    """List members (guests and users) for the given instance."""
    user = get_current_user(request)
    if user["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot view member list")

    if user["role"] != "admin":
        user_slug = getattr(request.state, "instance_slug", None)
        if user_slug != slug:
            raise HTTPException(status_code=403, detail="Cannot view other instances")

    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, m.role, u.created_at
            FROM _core.memberships m
            JOIN _core.users u ON u.id = m.user_id
            JOIN _core.instances i ON i.id = m.instance_id
            WHERE i.slug = %s
            ORDER BY u.username
            """,
            (slug,),
        ).fetchall()

    members = []
    for uid, uname, dname, role, created in rows:
        members.append({
            "user_id": uid,
            "username": uname,
            "display_name": dname,
            "role": role,
            "created_at": created.isoformat() if created else None,
        })

    return {"instance": slug, "members": members}


@router.delete("/instances/{slug}/guests/{user_id}")
def remove_guest(slug: str, user_id: int, request: Request) -> dict[str, Any]:
    """Remove a guest/user from an instance (user/admin only)."""
    current = get_current_user(request)
    if current["role"] == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot remove members")

    if current["role"] != "admin":
        user_slug = getattr(request.state, "instance_slug", None)
        if user_slug != slug:
            raise HTTPException(status_code=403, detail="Cannot manage other instances")

    # Prevent self-removal.
    if current["id"] == user_id:
        raise HTTPException(status_code=400, detail="Cannot remove yourself")

    with db_conn() as conn:
        inst = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (slug,)
        ).fetchone()
        if not inst:
            raise HTTPException(status_code=404, detail="Instance not found")

        deleted = conn.execute(
            """
            DELETE FROM _core.memberships
            WHERE user_id = %s AND instance_id = %s
            RETURNING user_id
            """,
            (user_id, inst[0]),
        ).fetchone()

        if not deleted:
            raise HTTPException(status_code=404, detail="Membership not found")

        # Also delete the user account if they're a guest (they can't exist without a membership).
        target_user = conn.execute(
            "SELECT role FROM _core.users WHERE id = %s", (user_id,)
        ).fetchone()
        if target_user and target_user[0] == "guest":
            conn.execute("DELETE FROM _core.users WHERE id = %s", (user_id,))

        conn.commit()

    return {"ok": True}


# ─── Admin-only endpoints ───

@router.get("/admin/instances")
def admin_list_instances(request: Request) -> dict[str, Any]:
    user = get_current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, slug, display_name, created_at FROM _core.instances ORDER BY id"
        ).fetchall()

    return {
        "instances": [
            {"id": r[0], "slug": r[1], "display_name": r[2], "created_at": r[3].isoformat() if r[3] else None}
            for r in rows
        ]
    }


@router.get("/admin/users")
def admin_list_users(request: Request) -> dict[str, Any]:
    user = get_current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, u.role, i.slug AS instance_slug
            FROM _core.users u
            LEFT JOIN _core.memberships m ON m.user_id = u.id
            LEFT JOIN _core.instances i ON i.id = m.instance_id
            ORDER BY u.id
            """
        ).fetchall()

    return {
        "users": [
            {
                "id": r[0],
                "username": r[1],
                "display_name": r[2],
                "role": r[3],
                "instance": r[4],
            }
            for r in rows
        ]
    }
