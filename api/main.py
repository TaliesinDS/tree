from __future__ import annotations

from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

try:
    from .routes.demo import router as demo_router
    from .routes.events import router as events_router
    from .routes.families import router as families_router
    from .routes.graph import router as graph_router
    from .routes.health import router as health_router
    from .routes.people import router as people_router
    from .routes.places import router as places_router
    from .routes.relationship import router as relationship_router
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from routes.demo import router as demo_router
    from routes.events import router as events_router
    from routes.families import router as families_router
    from routes.graph import router as graph_router
    from routes.health import router as health_router
    from routes.people import router as people_router
    from routes.places import router as places_router
    from routes.relationship import router as relationship_router

app = FastAPI(title="Genealogy API", version="0.0.1")


_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


app.include_router(health_router)
app.include_router(demo_router)
app.include_router(graph_router)
app.include_router(people_router)

app.include_router(families_router)
app.include_router(events_router)
app.include_router(places_router)
app.include_router(relationship_router)
