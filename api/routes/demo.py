from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

router = APIRouter()

_STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


@router.get("/static/graph_demo.htm", include_in_schema=False)
def static_graph_demo_htm_redirect() -> RedirectResponse:
    # Common typo/missing 'l'. Keep old links working.
    return RedirectResponse(url="/static/graph_demo.html", status_code=307)


@router.get("/demo/graph")
def demo_graph() -> FileResponse:
    """Interactive Cytoscape demo for the /graph/neighborhood endpoint."""

    path = _STATIC_DIR / "graph_demo.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="demo not found")
    return FileResponse(path)


@router.get("/demo/viewer")
def demo_viewer() -> FileResponse:
    """Starter Gramps-Web-like viewer shell (Graph + People + Events + Map tabs)."""

    # Viewer that ports the graph demo layout (graph_demo.html is kept as reference).
    path = _STATIC_DIR / "viewer_ported.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="viewer not found")
    return FileResponse(path)


@router.get("/demo/relationship")
def demo_relationship() -> FileResponse:
    """Relationship chart (Graphviz WASM) demo.

    Focused, modular frontend that renders a Gramps-Web-like relationship chart.
    """

    path = _STATIC_DIR / "relchart" / "index.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="demo not found")
    return FileResponse(path)
