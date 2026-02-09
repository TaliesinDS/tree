"""Routes for importing a Gramps file via the web UI.

Endpoints:
  POST /import       — upload a .gpkg/.gramps file, triggers import pipeline
  GET  /import/status — returns current import state (idle/running/done/failed)
"""

from __future__ import annotations

import os
import threading

from fastapi import APIRouter, HTTPException, UploadFile, File

try:
    from ..import_service import (
        ALLOWED_EXTENSIONS,
        MAX_UPLOAD_BYTES,
        get_import_state,
        run_import,
    )
    from ..db import get_database_url
except ImportError:
    from import_service import (
        ALLOWED_EXTENSIONS,
        MAX_UPLOAD_BYTES,
        get_import_state,
        run_import,
    )
    from db import get_database_url

router = APIRouter(tags=["import"])


@router.post("/import")
async def import_upload(file: UploadFile = File(...)):
    """Accept a Gramps package upload and start the import pipeline."""

    # Validate filename / extension.
    filename = (file.filename or "upload").strip()
    ext = ""
    for allowed_ext in ALLOWED_EXTENSIONS:
        if filename.lower().endswith(allowed_ext):
            ext = allowed_ext
            break
    if not ext:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # Check if an import is already running.
    current = get_import_state()
    if current["status"] == "running":
        raise HTTPException(status_code=409, detail="An import is already in progress")

    # Read file bytes (with size limit).
    file_bytes = await file.read()
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(file_bytes):,} bytes). Max: {MAX_UPLOAD_BYTES:,} bytes.",
        )
    if len(file_bytes) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    database_url = get_database_url()

    # Start import in a background thread so the HTTP response returns immediately.
    t = threading.Thread(
        target=run_import,
        args=(file_bytes, filename, database_url),
        daemon=True,
        name="import-worker",
    )
    t.start()

    return {"status": "started", "filename": filename, "size": len(file_bytes)}


@router.get("/import/status")
async def import_status():
    """Return the current import state."""
    return get_import_state()
