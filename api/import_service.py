"""Import orchestrator: accepts a Gramps file, exports to JSONL, loads into Postgres.

This module is the bridge between the browser upload and the existing
export/load pipeline scripts.  It enforces a global lock so only one
import can run at a time.
"""

from __future__ import annotations

import gzip
import io
import json
import logging
import os
import shutil
import tarfile
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


def _media_dir(instance_slug: str | None) -> Path:
    """Return the on-disk media directory for an instance."""
    api_dir = Path(__file__).resolve().parent
    slug = instance_slug or "default"
    return api_dir / "media" / slug


def _extract_media_files(
    file_bytes: bytes,
    jsonl_dir: Path,
    instance_slug: str | None,
) -> int:
    """Extract image files from a .gpkg tar archive and generate thumbnails.

    Returns the number of media files successfully extracted.
    """
    media_jsonl = jsonl_dir / "media.jsonl"
    if not media_jsonl.exists():
        return 0

    # Build a lookup: original_path -> media record
    media_by_path: dict[str, dict[str, Any]] = {}
    media_by_id: dict[str, dict[str, Any]] = {}
    with media_jsonl.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            orig = rec.get("original_path") or ""
            media_by_id[rec["id"]] = rec
            if orig:
                media_by_path[orig] = rec
                # Also index by basename for flexible matching
                basename = orig.rsplit("/", 1)[-1] if "/" in orig else orig
                if basename and basename not in media_by_path:
                    media_by_path[basename] = rec

    if not media_by_path:
        return 0

    dest = _media_dir(instance_slug)
    orig_dir = dest / "original"
    thumb_dir = dest / "thumb"
    orig_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    extracted = 0

    # Try to open as a tar archive (gzip'd tar is the .gpkg format)
    payload = file_bytes
    # Unwrap gzip if needed
    if payload[:2] == b"\x1f\x8b":
        payload = gzip.decompress(payload)

    try:
        tf = tarfile.open(fileobj=io.BytesIO(payload), mode="r:*")
    except tarfile.ReadError:
        # If gzip-decompressed bytes aren't a tar, try original
        try:
            tf = tarfile.open(fileobj=io.BytesIO(file_bytes), mode="r:*")
        except tarfile.ReadError:
            log.warning("Could not open archive as tar — skipping media extraction")
            return 0

    try:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            name = member.name
            # Skip the data.gramps XML file
            lower = name.lower()
            if lower.endswith((".gramps", ".xml", ".xml.gz", ".gramps.gz")):
                continue

            # Match tar member to a media record
            rec = media_by_path.get(name)
            if not rec:
                basename = name.rsplit("/", 1)[-1] if "/" in name else name
                rec = media_by_path.get(basename)
            if not rec:
                # Try matching by stripping leading path components
                for key in media_by_path:
                    if name.endswith(key) or key.endswith(name.rsplit("/", 1)[-1] if "/" in name else name):
                        rec = media_by_path[key]
                        break
            if not rec:
                continue

            handle = rec["id"]
            mime = (rec.get("mime") or "").lower()
            ext = _mime_to_ext(mime) or _ext_from_path(name)

            fh = tf.extractfile(member)
            if fh is None:
                continue
            img_bytes = fh.read()
            if not img_bytes:
                continue

            # Save original
            orig_path = orig_dir / f"{handle}{ext}"
            orig_path.write_bytes(img_bytes)

            # Update media record with file size
            rec["file_size"] = len(img_bytes)

            # Generate thumbnail
            try:
                _generate_thumbnail(img_bytes, thumb_dir / f"{handle}.png", rec)
            except Exception as e:
                log.warning("Thumbnail generation failed for %s: %s", handle, e)

            extracted += 1
    finally:
        tf.close()

    # Update media.jsonl with file_size/width/height discovered during extraction
    if extracted > 0:
        with media_jsonl.open("w", encoding="utf-8") as f:
            for rec in media_by_id.values():
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    return extracted


def _mime_to_ext(mime: str) -> str:
    """Map MIME type to file extension."""
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/webp": ".webp",
        "image/tiff": ".tiff",
        "image/bmp": ".bmp",
    }
    return mapping.get(mime, "")


def _ext_from_path(path: str) -> str:
    """Extract extension from a file path."""
    if "." in path:
        ext = "." + path.rsplit(".", 1)[-1].lower()
        if len(ext) <= 5:
            return ext
    return ".bin"


def _generate_thumbnail(img_bytes: bytes, thumb_path: Path, rec: dict[str, Any]) -> None:
    """Generate a 200x200 PNG thumbnail using Pillow.

    PNG is used instead of JPEG to preserve transparency for coat-of-arms
    and other images with alpha channels.
    """
    try:
        from PIL import Image
    except ImportError:
        log.warning("Pillow not installed — skipping thumbnail generation")
        return

    img = Image.open(io.BytesIO(img_bytes))

    # Record dimensions
    rec["width"] = img.width
    rec["height"] = img.height

    # Convert to RGBA to preserve transparency uniformly
    if img.mode not in ("RGBA", "RGB"):
        img = img.convert("RGBA")

    img.thumbnail((200, 200))
    img.save(str(thumb_path), "PNG", optimize=True)


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

            # 3b. Extract media files from archive and generate thumbnails.
            log.info("Extracting media files …")
            media_count = _extract_media_files(
                file_bytes=file_bytes,
                jsonl_dir=jsonl_dir,
                instance_slug=instance_slug,
            )
            log.info("Extracted %d media files", media_count)

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
