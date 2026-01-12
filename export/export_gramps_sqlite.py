"""Export from Gramps SQLite to a normalized, privacy-safe dataset.

Status: intentionally not implemented.

Reason:
- Gramps stores many important fields inside `blob_data` (internal serialization).
- For a robust, feature-complete export (notes/events/places), the better route is:
    Gramps → Export → Gramps XML (.gramps) → parse XML.

Use `export_gramps_package.py` instead.
"""

from __future__ import annotations


def main() -> int:
    raise SystemExit(
        "Not implemented. Use genealogy/export/export_gramps_package.py on a .gramps export."
    )


if __name__ == "__main__":
    raise SystemExit(main())
