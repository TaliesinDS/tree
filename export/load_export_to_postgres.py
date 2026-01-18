from __future__ import annotations

import argparse
import json
import os
import re
from datetime import date
from pathlib import Path
from typing import Any, Iterable

import psycopg


_DATE_RE = re.compile(r"\b(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})\b")


def _parse_full_date(s: str | None) -> date | None:
    if not s:
        return None
    # Dates may be prefixed (e.g. "estimated 1920-10-20").
    m = _DATE_RE.search(s)
    if not m:
        return None
    return date(int(m.group("y")), int(m.group("m")), int(m.group("d")))


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def _apply_schema(conn: psycopg.Connection, schema_sql_path: Path) -> None:
    sql = schema_sql_path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)


def _truncate_all(conn: psycopg.Connection) -> None:
    # Order matters due to FKs.
    tables = [
        "family_event",
        "family_child",
        "family",
        "event_note",
        "person_note",
        "person_event",
        "person_parent",
        "event",
        "place",
        "note",
        "person",
    ]
    with conn.cursor() as cur:
        for t in tables:
            cur.execute(f"TRUNCATE TABLE {t} CASCADE;")


def load_export(export_dir: Path, schema_sql_path: Path, database_url: str, truncate: bool) -> dict[str, int]:
    export_dir = export_dir.resolve()
    if not export_dir.exists():
        raise SystemExit(f"Export dir not found: {export_dir}")

    required = [
        "people.jsonl",
        "families.jsonl",
        "person_parent.jsonl",
        "events.jsonl",
        "places.jsonl",
        "notes.jsonl",
        "person_event.jsonl",
        "person_note.jsonl",
        "event_note.jsonl",
        "family_event.jsonl",
    ]
    missing = [name for name in required if not (export_dir / name).exists()]
    if missing:
        raise SystemExit(f"Export dir missing files: {', '.join(missing)}")

    counts: dict[str, int] = {}

    with psycopg.connect(database_url) as conn:
        conn.execute("SET statement_timeout TO '5min'")
        _apply_schema(conn, schema_sql_path)
        if truncate:
            _truncate_all(conn)

        # Places
        places_path = export_dir / "places.jsonl"
        rows = list(_iter_jsonl(places_path))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO place (id, gramps_id, name, place_type, enclosed_by_id, lat, lon, geom, is_private)
                VALUES (%s, %s, %s, %s, %s, %s, %s,
                        CASE WHEN %s::double precision IS NOT NULL AND %s::double precision IS NOT NULL
                            THEN ST_SetSRID(ST_MakePoint(%s::double precision, %s::double precision), 4326)::geography
                             ELSE NULL END,
                        %s)
                ON CONFLICT (id) DO UPDATE SET
                  gramps_id = EXCLUDED.gramps_id,
                  name = EXCLUDED.name,
                  place_type = EXCLUDED.place_type,
                  enclosed_by_id = EXCLUDED.enclosed_by_id,
                  lat = EXCLUDED.lat,
                  lon = EXCLUDED.lon,
                  geom = EXCLUDED.geom,
                  is_private = EXCLUDED.is_private;
                """.strip(),
                [
                    (
                        r.get("id"),
                        r.get("gramps_id"),
                        r.get("name"),
                        r.get("type") or r.get("place_type"),
                        r.get("enclosed_by") or r.get("enclosed_by_id"),
                        r.get("lat"),
                        r.get("lon"),
                        r.get("lat"),
                        r.get("lon"),
                        r.get("lon"),
                        r.get("lat"),
                        bool(r.get("is_private", False)),
                    )
                    for r in rows
                ],
            )
        counts["place"] = len(rows)

        # Notes
        notes_path = export_dir / "notes.jsonl"
        rows = list(_iter_jsonl(notes_path))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO note (id, body, is_private)
                VALUES (%s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                  body = EXCLUDED.body,
                  is_private = EXCLUDED.is_private;
                """.strip(),
                [(r.get("id"), r.get("body"), bool(r.get("is_private", False))) for r in rows],
            )
        counts["note"] = len(rows)

        # People
        people_path = export_dir / "people.jsonl"
        rows = list(_iter_jsonl(people_path))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO person (
                                    id, gramps_id, display_name, given_name, surname, gender,
                  birth_text, death_text, birth_date, death_date,
                  is_living, is_private
                )
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                                    gramps_id = EXCLUDED.gramps_id,
                  display_name = EXCLUDED.display_name,
                  given_name = EXCLUDED.given_name,
                  surname = EXCLUDED.surname,
                  gender = EXCLUDED.gender,
                  birth_text = EXCLUDED.birth_text,
                  death_text = EXCLUDED.death_text,
                  birth_date = EXCLUDED.birth_date,
                  death_date = EXCLUDED.death_date,
                  is_living = EXCLUDED.is_living,
                  is_private = EXCLUDED.is_private;
                """.strip(),
                [
                    (
                        r.get("id"),
                                                r.get("gramps_id"),
                        r.get("display_name"),
                        r.get("given_name"),
                        r.get("surname"),
                        r.get("gender"),
                        r.get("birth"),
                        r.get("death"),
                        _parse_full_date(r.get("birth")),
                        _parse_full_date(r.get("death")),
                        r.get("is_living"),
                        bool(r.get("is_private", False)),
                    )
                    for r in rows
                ],
            )
        counts["person"] = len(rows)

        # Families + family_child
        families_path = export_dir / "families.jsonl"
        fam_rows = list(_iter_jsonl(families_path))

        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO family (id, gramps_id, father_id, mother_id, is_private)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                  gramps_id = EXCLUDED.gramps_id,
                  father_id = EXCLUDED.father_id,
                  mother_id = EXCLUDED.mother_id,
                  is_private = EXCLUDED.is_private;
                """.strip(),
                [
                    (
                        r.get("id"),
                        r.get("gramps_id"),
                        r.get("father_id"),
                        r.get("mother_id"),
                        bool(r.get("is_private", False)),
                    )
                    for r in fam_rows
                ],
            )
        counts["family"] = len(fam_rows)

        fam_child_rows: list[tuple[str, str]] = []
        for r in fam_rows:
            fid = r.get("id")
            if not fid:
                continue
            for cid in (r.get("children") or []):
                if cid:
                    fam_child_rows.append((fid, cid))

        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO family_child (family_id, child_id)
                VALUES (%s,%s)
                ON CONFLICT (family_id, child_id) DO NOTHING;
                """.strip(),
                fam_child_rows,
            )
        counts["family_child"] = len(fam_child_rows)

        # Events
        events_path = export_dir / "events.jsonl"
        rows = list(_iter_jsonl(events_path))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO event (id, gramps_id, event_type, description, event_date_text, event_date, place_id, is_private)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                  gramps_id = EXCLUDED.gramps_id,
                  event_type = EXCLUDED.event_type,
                  description = EXCLUDED.description,
                  event_date_text = EXCLUDED.event_date_text,
                  event_date = EXCLUDED.event_date,
                  place_id = EXCLUDED.place_id,
                  is_private = EXCLUDED.is_private;
                """.strip(),
                [
                    (
                        r.get("id"),
                        r.get("gramps_id"),
                        r.get("type"),
                        r.get("description"),
                        r.get("date"),
                        _parse_full_date(r.get("date")),
                        r.get("place_id"),
                        bool(r.get("is_private", False)),
                    )
                    for r in rows
                ],
            )
        counts["event"] = len(rows)

        # Edges / links
        def load_link(file_name: str, sql: str, cols: list[str]) -> None:
            path = export_dir / file_name
            rows2 = list(_iter_jsonl(path))
            with conn.cursor() as cur:
                cur.executemany(sql, [tuple(r.get(c) for c in cols) for r in rows2])
            counts[file_name.replace(".jsonl", "")] = len(rows2)

        load_link(
            "person_parent.jsonl",
            """
            INSERT INTO person_parent (child_id, parent_id)
            VALUES (%s,%s)
            ON CONFLICT (child_id, parent_id) DO NOTHING;
            """.strip(),
            ["child_id", "parent_id"],
        )

        load_link(
            "person_event.jsonl",
            """
            INSERT INTO person_event (person_id, event_id, role)
            VALUES (%s,%s,%s)
            ON CONFLICT (person_id, event_id) DO UPDATE SET role = EXCLUDED.role;
            """.strip(),
            ["person_id", "event_id", "role"],
        )

        load_link(
            "person_note.jsonl",
            """
            INSERT INTO person_note (person_id, note_id)
            VALUES (%s,%s)
            ON CONFLICT (person_id, note_id) DO NOTHING;
            """.strip(),
            ["person_id", "note_id"],
        )

        load_link(
            "event_note.jsonl",
            """
            INSERT INTO event_note (event_id, note_id)
            VALUES (%s,%s)
            ON CONFLICT (event_id, note_id) DO NOTHING;
            """.strip(),
            ["event_id", "note_id"],
        )

        load_link(
            "family_event.jsonl",
            """
            INSERT INTO family_event (family_id, event_id, role)
            VALUES (%s,%s,%s)
            ON CONFLICT (family_id, event_id) DO UPDATE SET role = EXCLUDED.role;
            """.strip(),
            ["family_id", "event_id", "role"],
        )

        conn.commit()

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Load a JSONL export into Postgres")
    parser.add_argument("--export-dir", required=True, help="Dir containing people.jsonl, events.jsonl, etc")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL") or "",
        help="Postgres URL (or set DATABASE_URL env var)",
    )
    parser.add_argument(
        "--schema-sql",
        default=str(Path(__file__).resolve().parents[1] / "sql" / "schema.sql"),
        help="Path to schema.sql",
    )
    parser.add_argument("--truncate", action="store_true", help="Truncate existing tables before load")

    args = parser.parse_args()
    if not args.database_url:
        raise SystemExit("Missing --database-url (or set DATABASE_URL)")

    counts = load_export(
        export_dir=Path(args.export_dir),
        schema_sql_path=Path(args.schema_sql),
        database_url=args.database_url,
        truncate=args.truncate,
    )

    print(json.dumps({"loaded": counts}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
