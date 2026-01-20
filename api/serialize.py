from __future__ import annotations

from typing import Any

try:
    from .names import _format_public_person_names
    from .privacy import _is_effectively_private
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from names import _format_public_person_names
    from privacy import _is_effectively_private


def _person_node_row_to_public(r: tuple[Any, ...], *, distance: int | None = None) -> dict[str, Any]:
    # r = (
    #   id, gramps_id, display_name, given_name, surname, gender,
    #   birth_text, death_text, birth_date, death_date,
    #   is_living, is_private, is_living_override
    # )
    (
        pid,
        gid,
        name,
        given_name,
        surname,
        gender,
        birth_text,
        death_text,
        birth_date,
        death_date,
        is_living_flag,
        is_private_flag,
        is_living_override,
    ) = r

    if _is_effectively_private(
        is_private=is_private_flag,
        is_living_override=is_living_override,
        is_living=is_living_flag,
        birth_date=birth_date,
        death_date=death_date,
        birth_text=birth_text,
        death_text=death_text,
    ):
        return {
            "id": pid,
            "gramps_id": gid,
            "type": "person",
            "display_name": "Private",
            "given_name": None,
            "surname": None,
            "gender": None,
            "birth": None,
            "death": None,
            "distance": distance,
        }

    display_name_out, given_name_out, surname_out = _format_public_person_names(
        display_name=name,
        given_name=given_name,
        surname=surname,
    )
    return {
        "id": pid,
        "gramps_id": gid,
        "type": "person",
        "display_name": display_name_out,
        "given_name": given_name_out,
        "surname": surname_out,
        "gender": gender,
        "birth": birth_text,
        "death": death_text,
        "distance": distance,
    }
