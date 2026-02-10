"""Authentication and authorization helpers.

Provides:
- Password hashing (bcrypt via passlib)
- JWT creation and verification (PyJWT)
- FastAPI dependencies for extracting the current user and enforcing roles
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request, Response
from passlib.context import CryptContext

# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Minimum password requirements.
_PASSWORD_MIN_LENGTH = 8


def validate_password(plain: str) -> str | None:
    """Return an error message if ``plain`` is too weak, else ``None``."""
    if len(plain) < _PASSWORD_MIN_LENGTH:
        return f"Password must be at least {_PASSWORD_MIN_LENGTH} characters."
    has_upper = any(c.isupper() for c in plain)
    has_lower = any(c.islower() for c in plain)
    has_digit = any(c.isdigit() for c in plain)
    if not (has_upper and has_lower and has_digit):
        return "Password must contain at least one uppercase letter, one lowercase letter, and one digit."
    return None


def hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

_JWT_SECRET_ENV = "JWT_SECRET"
_JWT_ALGORITHM = "HS256"
_JWT_LIFETIME_HOURS = 24
_JWT_COOKIE_NAME = "tree_session"
_JWT_REFRESH_FRACTION = 0.5  # issue new token when >50 % of lifetime has passed


def _get_jwt_secret() -> str:
    secret = os.environ.get(_JWT_SECRET_ENV, "")
    if not secret:
        # Fallback for development — NOT safe for production.
        secret = "dev-secret-change-me"
    return secret


def create_jwt(
    user_id: int,
    username: str,
    role: str,
    instance_slug: str | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "instance": instance_slug,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=_JWT_LIFETIME_HOURS)).timestamp()),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=_JWT_ALGORITHM)


def decode_jwt(token: str) -> dict[str, Any]:
    """Decode and verify a JWT.  Raises ``jwt.PyJWTError`` on failure."""
    return jwt.decode(token, _get_jwt_secret(), algorithms=[_JWT_ALGORITHM])


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=_JWT_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=_JWT_LIFETIME_HOURS * 3600,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=_JWT_COOKIE_NAME, path="/")


def _should_refresh(claims: dict[str, Any]) -> bool:
    """Return True when >50 % of the token lifetime has elapsed."""
    iat = claims.get("iat", 0)
    exp = claims.get("exp", 0)
    if not iat or not exp:
        return False
    lifetime = exp - iat
    if lifetime <= 0:
        return False
    elapsed = time.time() - iat
    return elapsed > (lifetime * _JWT_REFRESH_FRACTION)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------


def get_current_user(request: Request) -> dict[str, Any]:
    """Extract the authenticated user from ``request.state`` (set by middleware).

    Raises 401 if not authenticated.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_role(*allowed_roles: str):
    """Return a FastAPI dependency that checks the user's role."""

    def _check(request: Request) -> dict[str, Any]:
        user = get_current_user(request)
        if user["role"] not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user

    return Depends(_check)


def get_instance_slug(request: Request) -> str:
    """Return the active instance slug from the request (set by middleware).

    Raises 400 if no instance is selected.
    """
    slug = getattr(request.state, "instance_slug", None)
    if not slug:
        raise HTTPException(status_code=400, detail="No instance selected")
    return slug
