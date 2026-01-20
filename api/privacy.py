from __future__ import annotations

from datetime import date
import re

_PRIVACY_BORN_ON_OR_AFTER = date(1946, 1, 1)
_PRIVACY_AGE_CUTOFF_YEARS = 90


def _add_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        # Handle Feb 29 -> Feb 28 in non-leap years.
        return d.replace(month=2, day=28, year=d.year + years)


def _is_younger_than(birth: date, years: int, *, today: date | None = None) -> bool:
    t = today or date.today()
    return t < _add_years(birth, years)


def _is_effectively_living(
    *,
    is_living_override: bool | None,
    is_living: bool | None,
    death_date: date | None,
) -> bool | None:
    if is_living_override is not None:
        return bool(is_living_override)
    if is_living is not None:
        return bool(is_living)
    if death_date is not None:
        return False
    return None


def _is_effectively_private(
    *,
    is_private: bool | None,
    is_living_override: bool | None,
    is_living: bool | None,
    birth_date: date | None,
    death_date: date | None,
    birth_text: str | None = None,
    death_text: str | None = None,
    today: date | None = None,
) -> bool:
    """Privacy policy:

    - Explicitly private => private
    - If (effectively) living:
      - born >= 1946-01-01 => private
      - else if age < 90 => private
      - else public
    - Unknown birth date: privacy-first => private (for living/unknown living)
    """

    if bool(is_private):
        return True

    t = today or date.today()

    def _year_from_text(s: str | None) -> int | None:
        if not s:
            return None
        # Heuristic: look for any 4-digit year.
        # This intentionally keeps parsing simple and conservative.
        m = re.search(r"\b(\d{4})\b", str(s))
        if not m:
            return None
        try:
            y = int(m.group(1))
        except ValueError:
            return None
        # Avoid matching nonsense years.
        if y < 1 or y > t.year + 5:
            return None
        return y

    # If there's a credible death year in text, treat as not living.
    death_year = _year_from_text(death_text)
    death_date_hint = death_date
    if death_date_hint is None and death_year is not None:
        try:
            death_date_hint = date(death_year, 1, 1)
        except ValueError:
            death_date_hint = None

    living = _is_effectively_living(
        is_living_override=is_living_override,
        is_living=is_living,
        death_date=death_date_hint,
    )
    if living is False:
        return False

    # living is True or unknown
    birth_date_hint = birth_date
    if birth_date_hint is None:
        birth_year = _year_from_text(birth_text)
        if birth_year is not None:
            try:
                birth_date_hint = date(birth_year, 1, 1)
            except ValueError:
                birth_date_hint = None

    # Unknown birth date: privacy-first.
    if birth_date_hint is None:
        return True

    if birth_date_hint >= _PRIVACY_BORN_ON_OR_AFTER:
        return True
    if _is_younger_than(birth_date_hint, _PRIVACY_AGE_CUTOFF_YEARS, today=t):
        return True
    return False
