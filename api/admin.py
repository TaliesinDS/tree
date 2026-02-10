"""CLI admin tool for managing users, instances, and memberships.

Usage:
    python -m api.admin create-admin --username=admin --password=secret
    python -m api.admin create-instance --slug=hofland --name="Hofland Family Tree"
    python -m api.admin create-user --username=jan --password=secret --role=user --instance=hofland
    python -m api.admin add-member --username=admin --instance=hofland
    python -m api.admin list-users
    python -m api.admin list-instances
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import psycopg

# Ensure the repo root is on sys.path so relative imports work.
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from api.auth import hash_password, validate_password  # noqa: E402

_SLUG_RE = re.compile(r"^[a-z0-9_]{1,32}$")


def _get_db_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise SystemExit("DATABASE_URL not set")
    return url


def _ensure_core_schema(conn: psycopg.Connection) -> None:
    schema_sql = Path(__file__).resolve().parent.parent / "sql" / "schema_core.sql"
    if schema_sql.exists():
        conn.execute(schema_sql.read_text(encoding="utf-8"))
        conn.commit()


def cmd_create_admin(args: argparse.Namespace) -> None:
    pw_err = validate_password(args.password)
    if pw_err:
        raise SystemExit(f"Weak password: {pw_err}")
    pw_hash = hash_password(args.password)
    with psycopg.connect(_get_db_url()) as conn:
        _ensure_core_schema(conn)
        conn.execute(
            """
            INSERT INTO _core.users (username, display_name, password_hash, role)
            VALUES (%s, %s, %s, 'admin')
            ON CONFLICT (username) DO UPDATE
              SET password_hash = EXCLUDED.password_hash,
                  role = 'admin',
                  updated_at = now()
            """,
            (args.username, args.display_name or args.username, pw_hash),
        )
        conn.commit()
    print(f"Admin user '{args.username}' created/updated.")


def cmd_create_instance(args: argparse.Namespace) -> None:
    slug = args.slug.lower().strip()
    if not _SLUG_RE.match(slug):
        raise SystemExit(f"Invalid slug '{slug}'. Must match {_SLUG_RE.pattern}")

    schema_name = f"inst_{slug}"
    genealogy_schema_sql = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"

    with psycopg.connect(_get_db_url()) as conn:
        _ensure_core_schema(conn)

        # Insert instance record.
        conn.execute(
            """
            INSERT INTO _core.instances (slug, display_name)
            VALUES (%s, %s)
            ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
            """,
            (slug, args.name),
        )

        # Create the instance schema and its tables.
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {schema_name}")
        conn.execute(f"SET search_path TO {schema_name}, public")

        if genealogy_schema_sql.exists():
            conn.execute(genealogy_schema_sql.read_text(encoding="utf-8"))

        # Create user_note table inside the instance schema.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_note (
              id          SERIAL PRIMARY KEY,
              gramps_id   TEXT NOT NULL,
              user_id     INT NOT NULL,
              body        TEXT NOT NULL DEFAULT '',
              created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_user_note_gramps_id ON user_note(gramps_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_user_note_user_id ON user_note(user_id)")

        conn.commit()
    print(f"Instance '{slug}' created (schema: {schema_name}).")


def cmd_create_user(args: argparse.Namespace) -> None:
    role = args.role.lower().strip()
    if role not in ("user", "guest"):
        raise SystemExit(f"Invalid role '{role}'. Must be 'user' or 'guest'.")

    pw_err = validate_password(args.password)
    if pw_err:
        raise SystemExit(f"Weak password: {pw_err}")

    pw_hash = hash_password(args.password)
    with psycopg.connect(_get_db_url()) as conn:
        _ensure_core_schema(conn)

        # Create or update the user.
        conn.execute(
            """
            INSERT INTO _core.users (username, display_name, password_hash, role)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (username) DO UPDATE
              SET password_hash = EXCLUDED.password_hash,
                  role = EXCLUDED.role,
                  display_name = EXCLUDED.display_name,
                  updated_at = now()
            RETURNING id
            """,
            (args.username, args.display_name or args.username, pw_hash, role),
        )
        user_id = conn.execute(
            "SELECT id FROM _core.users WHERE username = %s", (args.username,)
        ).fetchone()[0]

        # Assign to the instance.
        inst = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (args.instance,)
        ).fetchone()
        if not inst:
            raise SystemExit(f"Instance '{args.instance}' not found.")

        conn.execute(
            """
            INSERT INTO _core.memberships (user_id, instance_id, role)
            VALUES (%s, %s, %s)
            ON CONFLICT (user_id, instance_id) DO UPDATE SET role = EXCLUDED.role
            """,
            (user_id, inst[0], role),
        )
        conn.commit()
    print(f"User '{args.username}' ({role}) assigned to instance '{args.instance}'.")


def cmd_add_member(args: argparse.Namespace) -> None:
    role = (args.role or "user").lower().strip()
    with psycopg.connect(_get_db_url()) as conn:
        _ensure_core_schema(conn)

        user = conn.execute(
            "SELECT id, role FROM _core.users WHERE username = %s", (args.username,)
        ).fetchone()
        if not user:
            raise SystemExit(f"User '{args.username}' not found.")

        inst = conn.execute(
            "SELECT id FROM _core.instances WHERE slug = %s", (args.instance,)
        ).fetchone()
        if not inst:
            raise SystemExit(f"Instance '{args.instance}' not found.")

        # For admins, membership is optional but useful for default instance.
        conn.execute(
            """
            INSERT INTO _core.memberships (user_id, instance_id, role)
            VALUES (%s, %s, %s)
            ON CONFLICT (user_id, instance_id) DO UPDATE SET role = EXCLUDED.role
            """,
            (user[0], inst[0], role),
        )
        conn.commit()
    print(f"User '{args.username}' added to instance '{args.instance}' as '{role}'.")


def cmd_list_users(args: argparse.Namespace) -> None:
    with psycopg.connect(_get_db_url()) as conn:
        _ensure_core_schema(conn)
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, u.role,
                   i.slug AS instance_slug
            FROM _core.users u
            LEFT JOIN _core.memberships m ON m.user_id = u.id
            LEFT JOIN _core.instances i ON i.id = m.instance_id
            ORDER BY u.id
            """
        ).fetchall()

    if not rows:
        print("No users.")
        return
    print(f"{'ID':<5} {'Username':<20} {'Display Name':<25} {'Role':<8} {'Instance':<20}")
    print("-" * 80)
    for uid, uname, dname, role, inst_slug in rows:
        print(f"{uid:<5} {uname:<20} {(dname or '-'):<25} {role:<8} {(inst_slug or '-'):<20}")


def cmd_list_instances(args: argparse.Namespace) -> None:
    with psycopg.connect(_get_db_url()) as conn:
        _ensure_core_schema(conn)
        rows = conn.execute(
            "SELECT id, slug, display_name, created_at FROM _core.instances ORDER BY id"
        ).fetchall()

    if not rows:
        print("No instances.")
        return
    print(f"{'ID':<5} {'Slug':<20} {'Display Name':<30} {'Created':<20}")
    print("-" * 80)
    for iid, slug, dname, created in rows:
        print(f"{iid:<5} {slug:<20} {dname:<30} {str(created)[:19]:<20}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Tree admin CLI")
    sub = parser.add_subparsers(dest="command")

    # create-admin
    p = sub.add_parser("create-admin", help="Create or update an admin user")
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--display-name", default=None)

    # create-instance
    p = sub.add_parser("create-instance", help="Create a new family tree instance")
    p.add_argument("--slug", required=True, help="URL-safe identifier (e.g. 'hofland')")
    p.add_argument("--name", required=True, help="Display name (e.g. 'Hofland Family Tree')")

    # create-user
    p = sub.add_parser("create-user", help="Create a user or guest and assign to an instance")
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--role", required=True, choices=["user", "guest"])
    p.add_argument("--instance", required=True, help="Instance slug")
    p.add_argument("--display-name", default=None)

    # add-member
    p = sub.add_parser("add-member", help="Add an existing user to an instance")
    p.add_argument("--username", required=True)
    p.add_argument("--instance", required=True)
    p.add_argument("--role", default="user", choices=["user", "guest"])

    # list-users
    sub.add_parser("list-users", help="List all users")

    # list-instances
    sub.add_parser("list-instances", help="List all instances")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "create-admin": cmd_create_admin,
        "create-instance": cmd_create_instance,
        "create-user": cmd_create_user,
        "add-member": cmd_add_member,
        "list-users": cmd_list_users,
        "list-instances": cmd_list_instances,
    }
    dispatch[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
