from __future__ import annotations

from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

try:
    from .middleware import AuthMiddleware
    from .routes.auth import router as auth_router
    from .routes.demo import router as demo_router
    from .routes.events import router as events_router
    from .routes.families import router as families_router
    from .routes.graph import router as graph_router
    from .routes.health import router as health_router
    from .routes.import_tree import router as import_router
    from .routes.instance_members import router as members_router
    from .routes.people import router as people_router
    from .routes.places import router as places_router
    from .routes.relationship import router as relationship_router
    from .routes.user_notes import router as user_notes_router
except ImportError:  # pragma: no cover
    from middleware import AuthMiddleware
    from routes.auth import router as auth_router
    from routes.demo import router as demo_router
    from routes.events import router as events_router
    from routes.families import router as families_router
    from routes.graph import router as graph_router
    from routes.health import router as health_router
    from routes.import_tree import router as import_router
    from routes.instance_members import router as members_router
    from routes.people import router as people_router
    from routes.places import router as places_router
    from routes.relationship import router as relationship_router
    from routes.user_notes import router as user_notes_router

app = FastAPI(title="Genealogy API", version="0.0.1")

# Auth middleware — validates JWT cookie on every request.
app.add_middleware(AuthMiddleware)

_STATIC_DIR = Path(__file__).resolve().parent / "static"


# Serve login and instance-picker pages at clean URLs.
@app.get("/login", include_in_schema=False)
def login_page():
    return FileResponse(_STATIC_DIR / "login.html")


@app.get("/instance-picker", include_in_schema=False)
def instance_picker_page():
    return FileResponse(_STATIC_DIR / "instance_picker.html")


if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(demo_router)
app.include_router(graph_router)
app.include_router(people_router)
app.include_router(import_router)
app.include_router(user_notes_router)
app.include_router(members_router)

app.include_router(families_router)
app.include_router(events_router)
app.include_router(places_router)
app.include_router(relationship_router)
