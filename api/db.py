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
def db_conn() -> psycopg.Connection:
    # Simple per-request connection; good enough for now.
    # If/when this becomes hot, we can add pooling.
    with psycopg.connect(get_database_url()) as conn:
        yield conn
