from __future__ import annotations

import os
from contextlib import contextmanager

import psycopg


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


@contextmanager
def db_conn(instance_slug: str | None = None) -> psycopg.Connection:
    """Yield a database connection with the correct ``search_path``.

    - If *instance_slug* is provided, sets ``search_path`` to the
      instance schema (``inst_<slug>``), plus ``_core`` and ``public``.
    - Otherwise, uses ``public, _core`` for backwards compatibility and
      core-schema queries.
    """
    with psycopg.connect(get_database_url()) as conn:
        if instance_slug:
            schema = f"inst_{instance_slug}"
            conn.execute(f"SET search_path TO {schema}, _core, public")
        else:
            conn.execute("SET search_path TO public, _core")
        yield conn
