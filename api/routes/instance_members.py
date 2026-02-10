"""Instance member (guest) management routes.

Users and admins can create/list/delete guest accounts for their instance.
Admins can also manage user-level accounts.
"""

from __future__ import annotations

import re
from pathlib import Path
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

_SLUG_RE = re.compile(r"^[a-z0-9_]{1,32}$")


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


# ─── Admin create / delete endpoints ───


class CreateInstanceRequest(BaseModel):
    slug: str
    name: str


@router.post("/admin/instances")
def admin_create_instance(body: CreateInstanceRequest, request: Request) -> dict[str, Any]:
    """Create a new family-tree instance (admin only)."""
    user = get_current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    slug = body.slug.lower().strip()
    if not _SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail=f"Invalid slug. Must match {_SLUG_RE.pattern}")

    schema_name = f"inst_{slug}"
    genealogy_schema_sql = Path(__file__).resolve().parents[1].parent / "sql" / "schema.sql"

    with db_conn() as conn:
        # Check uniqueness.
        existing = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (slug,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Instance slug already exists")

        conn.execute(
            "INSERT INTO _core.instances (slug, display_name) VALUES (%s, %s)",
            (slug, body.name),
        )

        # Create schema + tables.
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {schema_name}")
        conn.execute(f"SET search_path TO {schema_name}, public")

        if genealogy_schema_sql.exists():
            conn.execute(genealogy_schema_sql.read_text(encoding="utf-8"))

        # user_note table.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_note (
              id          SERIAL PRIMARY KEY,
              gramps_id   TEXT NOT NULL,
              user_id     INT NOT NULL,
              body        TEXT NOT NULL DEFAULT '',
              created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_user_note_gramps_id ON user_note(gramps_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_user_note_user_id ON user_note(user_id)")

        conn.commit()

    return {"ok": True, "slug": slug, "name": body.name}


@router.delete("/admin/instances/{slug}")
def admin_delete_instance(slug: str, request: Request) -> dict[str, Any]:
    """Delete an instance and its schema (admin only)."""
    user = get_current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    schema_name = f"inst_{slug}"

    with db_conn() as conn:
        inst = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (slug,)
        ).fetchone()
        if not inst:
            raise HTTPException(status_code=404, detail="Instance not found")

        # Remove memberships, then instance record.
        conn.execute("DELETE FROM _core.memberships WHERE instance_id = %s", (inst[0],))
        conn.execute("DELETE FROM _core.instances WHERE id = %s", (inst[0],))

        # Drop the schema.
        conn.execute(f"DROP SCHEMA IF EXISTS {schema_name} CASCADE")
        conn.commit()

    return {"ok": True}


class AdminCreateUserRequest(BaseModel):
    username: str
    password: str
    role: str  # "user" or "guest"
    instance: str  # instance slug
    display_name: Optional[str] = None


@router.post("/admin/users")
def admin_create_user(body: AdminCreateUserRequest, request: Request) -> dict[str, Any]:
    """Create a user or guest and assign to an instance (admin only)."""
    user = get_current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    role = body.role.lower().strip()
    if role not in ("user", "guest"):
        raise HTTPException(status_code=400, detail="Role must be 'user' or 'guest'")

    pw_error = validate_password(body.password)
    if pw_error:
        raise HTTPException(status_code=400, detail=pw_error)

    pw_hash = hash_password(body.password)

    with db_conn() as conn:
        inst = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (body.instance,)
        ).fetchone()
        if not inst:
            raise HTTPException(status_code=404, detail=f"Instance '{body.instance}' not found")

        existing = conn.execute(
            "SELECT id FROM _core.users WHERE username = %s", (body.username,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username already taken")

        row = conn.execute(
            """
            INSERT INTO _core.users (username, display_name, password_hash, role)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (body.username, body.display_name or body.username, pw_hash, role),
        ).fetchone()
        new_id = row[0]

        conn.execute(
            "INSERT INTO _core.memberships (user_id, instance_id, role) VALUES (%s, %s, %s)",
            (new_id, inst[0], role),
        )
        conn.commit()

    return {"ok": True, "user_id": new_id, "username": body.username, "role": role, "instance": body.instance}


@router.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: int, request: Request) -> dict[str, Any]:
    """Delete a user account (admin only). Cannot delete yourself."""
    current = get_current_user(request)
    if current["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    if current["id"] == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    with db_conn() as conn:
        target = conn.execute("SELECT id, role FROM _core.users WHERE id = %s", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")

        conn.execute("DELETE FROM _core.memberships WHERE user_id = %s", (user_id,))
        conn.execute("DELETE FROM _core.users WHERE id = %s", (user_id,))
        conn.commit()

    return {"ok": True}
