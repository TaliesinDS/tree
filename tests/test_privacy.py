from __future__ import annotations

from datetime import date

from api.privacy import _is_effectively_private


def test_private_flag_always_private(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=True,
            is_living_override=None,
            is_living=None,
            birth_date=None,
            death_date=None,
            birth_text=None,
            death_text=None,
            today=fixed_today,
        )
        is True
    )


def test_born_on_or_after_1946_is_private_when_living(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=False,
            is_living_override=None,
            is_living=True,
            birth_date=date(1946, 1, 1),
            death_date=None,
            today=fixed_today,
        )
        is True
    )


def test_born_before_1946_over_90_is_public_when_living(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=False,
            is_living_override=None,
            is_living=True,
            birth_date=date(1930, 1, 1),
            death_date=None,
            today=fixed_today,
        )
        is False
    )


def test_born_before_1946_under_90_is_private_when_living(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=False,
            is_living_override=None,
            is_living=True,
            birth_date=date(1940, 1, 1),
            death_date=None,
            today=fixed_today,
        )
        is True
    )


def test_death_date_makes_public_unless_explicit_private(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=False,
            is_living_override=None,
            is_living=None,
            birth_date=date(2000, 1, 1),
            death_date=date(2020, 1, 1),
            today=fixed_today,
        )
        is False
    )


def test_unknown_birth_unknown_living_is_private(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=False,
            is_living_override=None,
            is_living=None,
            birth_date=None,
            death_date=None,
            birth_text=None,
            death_text=None,
            today=fixed_today,
        )
        is True
    )


def test_birth_year_from_text_fallback(fixed_today: date) -> None:
    assert (
        _is_effectively_private(
            is_private=False,
            is_living_override=None,
            is_living=True,
            birth_date=None,
            death_date=None,
            birth_text="abt 1930",
            death_text=None,
            today=fixed_today,
        )
        is False
    )
