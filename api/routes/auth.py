"""Auth routes: login, logout, current-user info, instance switching."""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

import psycopg
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

try:
    from ..auth import (
        clear_session_cookie,
        create_jwt,
        get_current_user,
        set_session_cookie,
        verify_password,
    )
    from ..db import db_conn
except ImportError:  # pragma: no cover
    from auth import (
        clear_session_cookie,
        create_jwt,
        get_current_user,
        set_session_cookie,
        verify_password,
    )
    from db import db_conn

router = APIRouter(prefix="/auth", tags=["auth"])

# ---------------------------------------------------------------------------
# Login rate limiting — 5 attempts per IP per 5-minute window (in-memory).
# ---------------------------------------------------------------------------

_RATE_MAX_ATTEMPTS = 5
_RATE_WINDOW_SECS = 300  # 5 minutes

# ip -> list of attempt timestamps (only failures counted)
_login_attempts: dict[str, list[float]] = defaultdict(list)


def _check_rate_limit(client_ip: str) -> None:
    """Raise 429 if the IP has too many recent failed login attempts."""
    now = time.monotonic()
    cutoff = now - _RATE_WINDOW_SECS
    attempts = _login_attempts[client_ip]
    # Prune old entries.
    _login_attempts[client_ip] = [t for t in attempts if t > cutoff]
    if len(_login_attempts[client_ip]) >= _RATE_MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many login attempts. Try again in {_RATE_WINDOW_SECS // 60} minutes.",
        )


def _record_failed_attempt(client_ip: str) -> None:
    _login_attempts[client_ip].append(time.monotonic())


def _clear_attempts(client_ip: str) -> None:
    _login_attempts.pop(client_ip, None)


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
    """Authenticate with username + password, set session cookie."""
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, username, display_name, password_hash, role FROM _core.users WHERE username = %s",
            (body.username,),
        ).fetchone()

    if not row:
        _record_failed_attempt(client_ip)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_id, username, display_name, password_hash, role = row

    if not verify_password(body.password, password_hash):
        _record_failed_attempt(client_ip)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Resolve instance slug for non-admin users.
    instance_slug: str | None = None
    if role != "admin":
        with db_conn() as conn:
            mem = conn.execute(
                """
                SELECT i.slug
                FROM _core.memberships m
                JOIN _core.instances i ON i.id = m.instance_id
                WHERE m.user_id = %s
                LIMIT 1
                """,
                (user_id,),
            ).fetchone()
        if not mem:
            raise HTTPException(status_code=403, detail="No instance assigned")
        instance_slug = mem[0]

    token = create_jwt(
        user_id=user_id,
        username=username,
        role=role,
        instance_slug=instance_slug,
    )
    set_session_cookie(response, token)
    _clear_attempts(client_ip)

    return {
        "ok": True,
        "user": {
            "id": user_id,
            "username": username,
            "display_name": display_name,
            "role": role,
        },
        "instance": instance_slug,
    }


@router.get("/logout")
def logout(response: Response) -> dict[str, str]:
    clear_session_cookie(response)
    return {"ok": "true"}


@router.get("/me")
def me(request: Request) -> dict[str, Any]:
    user = get_current_user(request)
    instance_slug = getattr(request.state, "instance_slug", None)

    result: dict[str, Any] = {
        "user": user,
        "instance": instance_slug,
        "instances": [],
    }

    # Admins can see all instances; others see their assigned one.
    if user["role"] == "admin":
        with db_conn() as conn:
            rows = conn.execute(
                "SELECT slug, display_name FROM _core.instances ORDER BY slug"
            ).fetchall()
        result["instances"] = [{"slug": r[0], "display_name": r[1]} for r in rows]
    elif instance_slug:
        with db_conn() as conn:
            row = conn.execute(
                "SELECT slug, display_name FROM _core.instances WHERE slug = %s",
                (instance_slug,),
            ).fetchone()
        if row:
            result["instances"] = [{"slug": row[0], "display_name": row[1]}]

    return result


class SwitchInstanceRequest(BaseModel):
    slug: str


@router.post("/switch-instance")
def switch_instance(body: SwitchInstanceRequest, request: Request, response: Response) -> dict[str, Any]:
    """Switch the active instance (admin only)."""
    user = get_current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admins can switch instances")

    # Verify the instance exists.
    with db_conn() as conn:
        row = conn.execute(
            "SELECT slug, display_name FROM _core.instances WHERE slug = %s",
            (body.slug,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Instance not found")

    token = create_jwt(
        user_id=user["id"],
        username=user["username"],
        role=user["role"],
        instance_slug=body.slug,
    )
    set_session_cookie(response, token)

    return {"ok": True, "instance": body.slug, "display_name": row[1]}
