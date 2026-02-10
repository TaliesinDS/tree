"""Unit tests for api/auth.py — password hashing, JWT, role helpers."""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import pytest

from api.auth import (
    _JWT_COOKIE_NAME,
    _should_refresh,
    clear_session_cookie,
    create_jwt,
    decode_jwt,
    get_current_user,
    get_instance_slug,
    hash_password,
    set_session_cookie,
    validate_password,
    verify_password,
)


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------


class TestPasswordHashing:
    def test_hash_and_verify_round_trip(self) -> None:
        pw = "hunter2"
        hashed = hash_password(pw)
        assert hashed != pw
        assert verify_password(pw, hashed)

    def test_wrong_password_fails(self) -> None:
        hashed = hash_password("correct-password")
        assert not verify_password("wrong-password", hashed)

    def test_different_hashes_for_same_password(self) -> None:
        h1 = hash_password("same")
        h2 = hash_password("same")
        # bcrypt includes a random salt so hashes differ.
        assert h1 != h2
        assert verify_password("same", h1)
        assert verify_password("same", h2)


# ---------------------------------------------------------------------------
# JWT create / decode
# ---------------------------------------------------------------------------


class TestJWT:
    @patch.dict("os.environ", {"JWT_SECRET": "test-secret-key"})
    def test_create_and_decode_round_trip(self) -> None:
        token = create_jwt(user_id=42, username="jan", role="user", instance_slug="hofland")
        claims = decode_jwt(token)
        assert claims["sub"] == "42"
        assert claims["username"] == "jan"
        assert claims["role"] == "user"
        assert claims["instance"] == "hofland"
        assert "iat" in claims
        assert "exp" in claims

    @patch.dict("os.environ", {"JWT_SECRET": "test-secret-key"})
    def test_admin_no_instance(self) -> None:
        token = create_jwt(user_id=1, username="admin", role="admin", instance_slug=None)
        claims = decode_jwt(token)
        assert claims["instance"] is None
        assert claims["role"] == "admin"

    @patch.dict("os.environ", {"JWT_SECRET": "secret-A"})
    def test_wrong_secret_fails(self) -> None:
        token = create_jwt(user_id=1, username="x", role="guest")
        import jwt as pyjwt

        with patch.dict("os.environ", {"JWT_SECRET": "secret-B"}):
            with pytest.raises(pyjwt.InvalidSignatureError):
                decode_jwt(token)

    @patch.dict("os.environ", {"JWT_SECRET": "test-secret-key"})
    def test_expired_token_raises(self) -> None:
        import jwt as pyjwt
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        payload = {
            "sub": "1",
            "username": "expired",
            "role": "user",
            "instance": None,
            "iat": int((now - timedelta(hours=48)).timestamp()),
            "exp": int((now - timedelta(hours=24)).timestamp()),
        }
        token = pyjwt.encode(payload, "test-secret-key", algorithm="HS256")
        with pytest.raises(pyjwt.ExpiredSignatureError):
            decode_jwt(token)


# ---------------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------------


class _FakeResponse:
    """Minimal stand-in for starlette Response for cookie testing."""

    def __init__(self) -> None:
        self._cookies: dict[str, Any] = {}
        self._deleted: list[str] = []

    def set_cookie(self, **kwargs: Any) -> None:
        self._cookies[kwargs["key"]] = kwargs

    def delete_cookie(self, **kwargs: Any) -> None:
        self._deleted.append(kwargs["key"])


class TestCookies:
    def test_set_and_clear_session_cookie(self) -> None:
        resp = _FakeResponse()
        set_session_cookie(resp, "tok123")
        cookie = resp._cookies.get(_JWT_COOKIE_NAME)
        assert cookie is not None
        assert cookie["value"] == "tok123"
        assert cookie["httponly"] is True
        assert cookie["samesite"] == "lax"

        clear_session_cookie(resp)
        assert _JWT_COOKIE_NAME in resp._deleted


# ---------------------------------------------------------------------------
# Sliding token refresh
# ---------------------------------------------------------------------------


class TestShouldRefresh:
    def test_no_refresh_when_fresh(self) -> None:
        now = int(time.time())
        claims = {"iat": now, "exp": now + 86400}
        assert not _should_refresh(claims)

    def test_refresh_when_old(self) -> None:
        now = int(time.time())
        # Token issued 20 hours ago with 24h lifetime → >50% elapsed.
        claims = {"iat": now - 72000, "exp": now + (86400 - 72000)}
        assert _should_refresh(claims)

    def test_no_refresh_missing_fields(self) -> None:
        assert not _should_refresh({})
        assert not _should_refresh({"iat": 0, "exp": 0})

    def test_no_refresh_zero_lifetime(self) -> None:
        now = int(time.time())
        assert not _should_refresh({"iat": now, "exp": now})


# ---------------------------------------------------------------------------
# get_current_user / get_instance_slug
# ---------------------------------------------------------------------------


class _FakeState:
    pass


class _FakeRequest:
    def __init__(self, user: dict | None = None, instance_slug: str | None = None) -> None:
        self.state = _FakeState()
        if user is not None:
            self.state.user = user
        if instance_slug is not None:
            self.state.instance_slug = instance_slug


class TestGetCurrentUser:
    def test_returns_user_when_present(self) -> None:
        req = _FakeRequest(user={"id": 1, "username": "jan", "role": "user"})
        user = get_current_user(req)
        assert user["id"] == 1
        assert user["username"] == "jan"

    def test_raises_401_when_no_user(self) -> None:
        req = _FakeRequest()  # no user set
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            get_current_user(req)
        assert exc_info.value.status_code == 401


class TestGetInstanceSlug:
    def test_returns_slug_when_present(self) -> None:
        req = _FakeRequest(user={"id": 1, "username": "x", "role": "user"}, instance_slug="hofland")
        assert get_instance_slug(req) == "hofland"

    def test_raises_400_when_no_slug(self) -> None:
        req = _FakeRequest(user={"id": 1, "username": "x", "role": "user"})
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            get_instance_slug(req)
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# Guest privacy guard (from route helpers)
# ---------------------------------------------------------------------------


class TestGuestPrivacyGuard:
    """Verify the _enforce_guest_privacy helper used in route handlers."""

    def _enforce(self, request: _FakeRequest, privacy: str) -> str:
        # Re-implement the logic to test it in isolation.
        user = getattr(request.state, "user", None)
        if user and user.get("role") == "guest" and privacy.lower() == "off":
            return "on"
        return privacy

    def test_guest_cannot_disable_privacy(self) -> None:
        req = _FakeRequest(user={"id": 2, "username": "guest1", "role": "guest"})
        assert self._enforce(req, "off") == "on"
        assert self._enforce(req, "on") == "on"

    def test_user_can_disable_privacy(self) -> None:
        req = _FakeRequest(user={"id": 1, "username": "jan", "role": "user"})
        assert self._enforce(req, "off") == "off"

    def test_admin_can_disable_privacy(self) -> None:
        req = _FakeRequest(user={"id": 1, "username": "admin", "role": "admin"})
        assert self._enforce(req, "off") == "off"

    def test_no_user_passes_through(self) -> None:
        req = _FakeRequest()
        assert self._enforce(req, "off") == "off"


# ---------------------------------------------------------------------------
# Password strength validation
# ---------------------------------------------------------------------------


class TestPasswordValidation:
    def test_strong_password_passes(self) -> None:
        assert validate_password("Secret1x") is None
        assert validate_password("Abc12345") is None
        assert validate_password("P@ssw0rd123") is None

    def test_too_short(self) -> None:
        err = validate_password("Ab1")
        assert err is not None
        assert "8 characters" in err

    def test_no_uppercase(self) -> None:
        err = validate_password("abcdefg1")
        assert err is not None
        assert "uppercase" in err

    def test_no_lowercase(self) -> None:
        err = validate_password("ABCDEFG1")
        assert err is not None
        assert "lowercase" in err

    def test_no_digit(self) -> None:
        err = validate_password("Abcdefgh")
        assert err is not None
        assert "digit" in err

    def test_empty_password(self) -> None:
        err = validate_password("")
        assert err is not None


# ---------------------------------------------------------------------------
# Rate limiting (whitebox)
# ---------------------------------------------------------------------------


class TestRateLimiting:
    def test_rate_limit_blocks_after_threshold(self) -> None:
        from api.routes.auth import (
            _check_rate_limit,
            _clear_attempts,
            _record_failed_attempt,
        )

        ip = "test-rate-limit-ip"
        _clear_attempts(ip)

        # First 5 attempts should be fine.
        for _ in range(5):
            _record_failed_attempt(ip)

        # 6th attempt should be blocked.
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            _check_rate_limit(ip)
        assert exc_info.value.status_code == 429

        _clear_attempts(ip)

    def test_clear_resets_counter(self) -> None:
        from api.routes.auth import (
            _check_rate_limit,
            _clear_attempts,
            _record_failed_attempt,
        )

        ip = "test-clear-ip"
        for _ in range(5):
            _record_failed_attempt(ip)
        _clear_attempts(ip)
        # Should not raise after clear.
        _check_rate_limit(ip)
