from __future__ import annotations

from api.names import _normalize_public_name_fields, _smart_title_case_name


def test_particle_lowercase_when_multi_token() -> None:
    assert _smart_title_case_name("VAN DER BERG") == "van der Berg"


def test_roman_numerals_uppercased() -> None:
    assert _smart_title_case_name("willem iii") == "Willem III"


def test_hyphen_and_apostrophe_handling() -> None:
    assert _smart_title_case_name("anne-marie") == "Anne-Marie"
    assert _smart_title_case_name("o'neill") == "O'Neill"


def test_private_preserved_exactly() -> None:
    assert _smart_title_case_name("Private") == "Private"


def test_paren_epithet_surname_moves_into_given_name() -> None:
    given, surname = _normalize_public_name_fields(
        display_name=None,
        given_name="phije jans",
        surname="(dragon)",
    )
    assert given == "phije jans (dragon)"
    assert surname is None
