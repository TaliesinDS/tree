"""Request-level authentication and instance resolution middleware.

Extracts the JWT from the session cookie, validates it, and populates:
  - ``request.state.user``          — dict with id, username, role
  - ``request.state.instance_slug`` — active instance slug (or None)

Unauthenticated requests to protected paths get a 401 or a redirect to /login.

Also enforces double-submit CSRF protection on state-changing methods.
"""

from __future__ import annotations

import os
import re
import secrets

import jwt as pyjwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

try:
    from .auth import (
        _JWT_COOKIE_NAME,
        _should_refresh,
        create_jwt,
        decode_jwt,
        set_session_cookie,
    )
except ImportError:  # pragma: no cover
    from auth import (
        _JWT_COOKIE_NAME,
        _should_refresh,
        create_jwt,
        decode_jwt,
        set_session_cookie,
    )

# Paths that do NOT require authentication.
_PUBLIC_PATHS: list[re.Pattern[str]] = [
    re.compile(r"^/health$"),
    re.compile(r"^/auth/login$"),
    re.compile(r"^/auth/logout$"),
    re.compile(r"^/login$"),
    re.compile(r"^/static/"),
    re.compile(r"^/docs$"),
    re.compile(r"^/openapi\.json$"),
    re.compile(r"^/favicon\.ico$"),
]

# CSRF settings.
_CSRF_COOKIE_NAME = "tree_csrf"
_CSRF_HEADER_NAME = "x-csrf-token"
_CSRF_TOKEN_LENGTH = 32
_CSRF_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _is_public(path: str) -> bool:
    for pat in _PUBLIC_PATHS:
        if pat.search(path):
            return True
    return False


def _wants_json(request: Request) -> bool:
    accept = request.headers.get("accept", "")
    return "application/json" in accept


def _ensure_csrf_cookie(request: Request, response: Response) -> None:
    """Set the CSRF cookie if not already present so JS can read it."""
    if request.cookies.get(_CSRF_COOKIE_NAME):
        return
    token = secrets.token_hex(_CSRF_TOKEN_LENGTH)
    response.set_cookie(
        key=_CSRF_COOKIE_NAME,
        value=token,
        httponly=False,  # JS must be able to read it.
        samesite="lax",
        path="/",
    )


class AuthMiddleware(BaseHTTPMiddleware):
    """Starlette middleware that enforces JWT-based authentication and CSRF."""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path

        # Always allow public endpoints.
        if _is_public(path):
            response = await call_next(request)
            _ensure_csrf_cookie(request, response)
            return response

        token = request.cookies.get(_JWT_COOKIE_NAME)
        if not token:
            if _wants_json(request):
                return JSONResponse({"detail": "Not authenticated"}, status_code=401)
            return RedirectResponse(url="/login", status_code=302)

        try:
            claims = decode_jwt(token)
        except pyjwt.ExpiredSignatureError:
            if _wants_json(request):
                return JSONResponse({"detail": "Session expired"}, status_code=401)
            return RedirectResponse(url="/login", status_code=302)
        except pyjwt.PyJWTError:
            if _wants_json(request):
                return JSONResponse({"detail": "Invalid session"}, status_code=401)
            return RedirectResponse(url="/login", status_code=302)

        # CSRF check for state-changing methods.
        if request.method not in _CSRF_SAFE_METHODS:
            csrf_cookie = request.cookies.get(_CSRF_COOKIE_NAME, "")
            csrf_header = request.headers.get(_CSRF_HEADER_NAME, "")
            if not csrf_cookie or not csrf_header or csrf_cookie != csrf_header:
                return JSONResponse({"detail": "CSRF token mismatch"}, status_code=403)

        # Populate request.state for downstream route handlers.
        request.state.user = {
            "id": int(claims["sub"]),
            "username": claims.get("username", ""),
            "role": claims.get("role", "guest"),
        }
        request.state.instance_slug = claims.get("instance") or None

        response = await call_next(request)

        # Ensure CSRF cookie is always present.
        _ensure_csrf_cookie(request, response)

        # Sliding window refresh: issue a new token when >50% of lifetime is gone.
        if _should_refresh(claims):
            new_token = create_jwt(
                user_id=int(claims["sub"]),
                username=claims.get("username", ""),
                role=claims.get("role", "guest"),
                instance_slug=claims.get("instance"),
            )
            set_session_cookie(response, new_token)

        return response
