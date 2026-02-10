"""Import orchestrator: accepts a Gramps file, exports to JSONL, loads into Postgres.

This module is the bridge between the browser upload and the existing
export/load pipeline scripts.  It enforces a global lock so only one
import can run at a time.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Import status tracking
# ---------------------------------------------------------------------------

class ImportStatus(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass
class ImportState:
    status: ImportStatus = ImportStatus.IDLE
    error: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    counts: dict = field(default_factory=dict)


_state = ImportState()
_lock = threading.Lock()

# Maximum upload size: 200 MB (Gramps packages can be large with media).
MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# Allowed extensions.
ALLOWED_EXTENSIONS = {".gpkg", ".gramps"}


def get_import_state() -> dict[str, Any]:
    """Return a JSON-serializable snapshot of the current import state."""
    return {
        "status": _state.status.value,
        "error": _state.error,
        "started_at": _state.started_at,
        "finished_at": _state.finished_at,
        "counts": _state.counts,
    }


def _resolve_paths() -> tuple[Path, Path]:
    """Locate the export scripts and schema SQL relative to this file.

    Layout:
        repo/
          api/import_service.py   <- this file
          export/                 <- exporter + loader
          sql/schema.sql          <- DDL
    """
    repo_root = Path(__file__).resolve().parent.parent
    export_dir = repo_root / "export"
    schema_sql = repo_root / "sql" / "schema.sql"

    if not export_dir.exists():
        raise FileNotFoundError(f"export/ directory not found at {export_dir}")
    if not schema_sql.exists():
        raise FileNotFoundError(f"schema.sql not found at {schema_sql}")

    return export_dir, schema_sql


def run_import(file_bytes: bytes, filename: str, database_url: str, *, instance_slug: str | None = None) -> None:
    """Run the import pipeline synchronously, updating ``_state`` throughout.

    This function MUST be called from a background thread (the route handler
    starts one).  It is guarded by ``_lock`` so only one import can run at a
    time.

    If *instance_slug* is provided, the import writes into the instance schema
    (``inst_<slug>``) instead of the ``public`` schema.
    """

    acquired = _lock.acquire(blocking=False)
    if not acquired:
        raise RuntimeError("An import is already in progress")

    try:
        _state.status = ImportStatus.RUNNING
        _state.error = None
        _state.started_at = time.time()
        _state.finished_at = None
        _state.counts = {}

        log.info("Import started for %s (%d bytes)", filename, len(file_bytes))

        # Import the pipeline modules lazily so the import path is resolved at
        # runtime (they live outside the ``api/`` package).
        import sys
        import importlib
        repo_root = Path(__file__).resolve().parent.parent
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))

        import export.export_gramps_package as _exp_mod
        import export.load_export_to_postgres as _load_mod
        importlib.reload(_exp_mod)
        importlib.reload(_load_mod)
        from export.export_gramps_package import export_from_xml, read_gramps_xml_bytes
        from export.load_export_to_postgres import load_export

        _, schema_sql = _resolve_paths()

        # Work inside a temporary directory.
        tmp_dir = Path(tempfile.mkdtemp(prefix="tree_import_"))
        try:
            # 1. Save uploaded bytes to a temp file.
            upload_path = tmp_dir / filename
            upload_path.write_bytes(file_bytes)

            # 2. Extract XML from the package.
            log.info("Extracting XML from %s …", filename)
            xml_bytes = read_gramps_xml_bytes(upload_path)

            # 3. Export to JSONL.
            jsonl_dir = tmp_dir / "jsonl"
            log.info("Exporting to JSONL in %s …", jsonl_dir)
            summary = export_from_xml(
                xml_bytes=xml_bytes,
                out_dir=jsonl_dir,
                living_cutoff_years=90,
                redact_living=False,
                redact_private=False,
            )
            log.info("Export summary: %s", summary)

            # 4. Load into Postgres (truncate + replace).
            log.info("Loading into Postgres (truncate mode) …")
            counts = load_export(
                export_dir=jsonl_dir,
                schema_sql_path=schema_sql,
                database_url=database_url,
                truncate=True,
                search_path_schema=f"inst_{instance_slug}" if instance_slug else None,
            )
            log.info("Load counts: %s", counts)

            _state.counts = counts
            _state.status = ImportStatus.DONE
            _state.finished_at = time.time()
            log.info("Import completed successfully in %.1fs", _state.finished_at - _state.started_at)

        finally:
            # Clean up temp directory.
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass

    except Exception as exc:
        log.exception("Import failed")
        _state.status = ImportStatus.FAILED
        _state.error = str(exc)
        _state.finished_at = time.time()

    finally:
        _lock.release()
