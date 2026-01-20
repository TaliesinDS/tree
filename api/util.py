from __future__ import annotations

from typing import Any


def _compact_json(value: Any) -> Any:
    """Recursively remove null/empty fields from JSON-like structures.

    Rules:
    - Drop keys with None
    - Drop keys with empty string (after strip)
    - Drop keys with empty list/dict
    - Keep 0/False
    """

    if value is None:
        return None

    if isinstance(value, str):
        s = value.strip()
        return s if s else None

    if isinstance(value, list):
        out_list = []
        for item in value:
            v = _compact_json(item)
            if v is None:
                continue
            out_list.append(v)
        return out_list if out_list else None

    if isinstance(value, dict):
        out_dict: dict[str, Any] = {}
        for k, v in value.items():
            vv = _compact_json(v)
            if vv is None:
                continue
            out_dict[k] = vv
        return out_dict if out_dict else None

    return value
