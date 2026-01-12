from __future__ import annotations

import argparse
import json
import os
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ColumnInfo:
    cid: int
    name: str
    col_type: str
    notnull: bool
    default_value: str | None
    is_pk: bool


@dataclass(frozen=True)
class ForeignKeyInfo:
    table: str
    from_col: str
    to_col: str
    on_update: str
    on_delete: str


@dataclass(frozen=True)
class IndexInfo:
    name: str
    unique: bool
    origin: str
    partial: bool


@dataclass(frozen=True)
class TableInfo:
    name: str
    columns: list[ColumnInfo]
    foreign_keys: list[ForeignKeyInfo]
    indexes: list[IndexInfo]
    create_sql: str | None


def _fetch_all_dict(cur: sqlite3.Cursor) -> list[dict[str, Any]]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def inspect_sqlite(db_path: Path) -> dict[str, Any]:
    con = sqlite3.connect(str(db_path))
    try:
        con.row_factory = sqlite3.Row
        cur = con.cursor()

        cur.execute("PRAGMA foreign_keys=ON;")
        cur.execute("PRAGMA database_list;")
        dbs = _fetch_all_dict(cur)

        cur.execute(
            "SELECT name, type, sql FROM sqlite_master "
            "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name;"
        )
        master = _fetch_all_dict(cur)

        tables: list[TableInfo] = []
        for row in master:
            if row["type"] != "table":
                continue

            name = str(row["name"])
            create_sql = row["sql"]

            cur.execute(f"PRAGMA table_info('{name.replace("'", "''")}');")
            cols = []
            for c in cur.fetchall():
                cols.append(
                    ColumnInfo(
                        cid=int(c[0]),
                        name=str(c[1]),
                        col_type=str(c[2] or ""),
                        notnull=bool(c[3]),
                        default_value=None if c[4] is None else str(c[4]),
                        is_pk=bool(c[5]),
                    )
                )

            cur.execute(f"PRAGMA foreign_key_list('{name.replace("'", "''")}');")
            fks = []
            for fk in cur.fetchall():
                # PRAGMA foreign_key_list columns: id, seq, table, from, to, on_update, on_delete, match
                fks.append(
                    ForeignKeyInfo(
                        table=str(fk[2]),
                        from_col=str(fk[3]),
                        to_col=str(fk[4]),
                        on_update=str(fk[5]),
                        on_delete=str(fk[6]),
                    )
                )

            cur.execute(f"PRAGMA index_list('{name.replace("'", "''")}');")
            idxs = []
            for idx in cur.fetchall():
                # PRAGMA index_list columns: seq, name, unique, origin, partial
                idxs.append(
                    IndexInfo(
                        name=str(idx[1]),
                        unique=bool(idx[2]),
                        origin=str(idx[3]),
                        partial=bool(idx[4]),
                    )
                )

            tables.append(
                TableInfo(
                    name=name,
                    columns=cols,
                    foreign_keys=fks,
                    indexes=idxs,
                    create_sql=None if create_sql is None else str(create_sql),
                )
            )

        return {
            "db_path": str(db_path),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "database_list": dbs,
            "sqlite_master": master,
            "tables": [asdict(t) for t in tables],
        }
    finally:
        con.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect a SQLite DB (for Gramps schema discovery)")
    parser.add_argument("--db", required=True, help="Path to Gramps SQLite database")
    parser.add_argument("--out", required=True, help="Path to write JSON report")
    parser.add_argument("--print", action="store_true", help="Also print a short summary")

    args = parser.parse_args()
    db_path = Path(args.db).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()

    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    out_path.parent.mkdir(parents=True, exist_ok=True)

    report = inspect_sqlite(db_path)
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    if args.print:
        tables = report.get("tables", [])
        print(f"DB: {db_path}")
        print(f"Tables: {len(tables)}")
        # quick highlights
        names = [t.get("name") for t in tables if isinstance(t, dict)]
        for hint in ("person", "family", "event", "place", "note"):
            hits = [n for n in names if isinstance(n, str) and hint in n.lower()]
            if hits:
                print(f"Contains {hint}: {', '.join(hits[:10])}{' ...' if len(hits) > 10 else ''}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
