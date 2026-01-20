from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any, Literal, Optional

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastapi import Body
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

try:
    from .db import db_conn
except ImportError:  # pragma: no cover
    # Support running with CWD=genealogy/api (e.g., `python -m uvicorn main:app`).
    from db import db_conn

app = FastAPI(title="Genealogy API", version="0.0.1")


_PRIVACY_BORN_ON_OR_AFTER = date(1946, 1, 1)
_PRIVACY_AGE_CUTOFF_YEARS = 90

# If someone is connected (parent/child) to a clearly-historic public person,
# we can safely assume they are not living, even if their own dates are missing.
_HISTORIC_YEAR_CUTOFF_YEARS_AGO = 150

_PAREN_EPITHET_RE = re.compile(r"^\([^()]{1,80}\)$")

# Name particles that are typically lowercase in surnames, including Dutch/German/French-style.
# We apply this conservatively for display only (DB remains unchanged).
_NAME_LOWER_PARTICLES = {
    "van",
    "der",
    "den",
    "de",
    "het",
    "ten",
    "ter",
    "te",
    "op",
    "aan",
    "in",
    "onder",
    "bij",
    "tot",
    "voor",
    "achter",
    "over",
    "uit",
    "von",
    "zu",
    "zur",
    "zum",
    "am",
    "im",
    "da",
    "di",
    "du",
    "des",
    "del",
    "della",
    "la",
    "le",
    "les",
}

_ROMAN_NUMERALS = {
    "i",
    "ii",
    "iii",
    "iv",
    "v",
    "vi",
    "vii",
    "viii",
    "ix",
    "x",
    "xi",
    "xii",
}


def _smart_title_case_name(raw: str | None) -> str | None:
    """Best-effort title casing for personal names.

    Goals:
    - Fix common ALLCAPS / lowercase exports for display.
    - Keep surname particles like "van der" lowercase (even at start) when name has >1 token.
    - Handle hyphens and apostrophes: "o'neill" -> "O'Neill", "anne-marie" -> "Anne-Marie".
    - Preserve "Private" exactly.

    This is heuristic and intentionally conservative.
    """

    if raw is None:
        return None

    s0 = str(raw).strip()
    if not s0:
        return None
    if s0 == "Private":
        return s0

    # Normalize whitespace to single spaces.
    tokens = [t for t in re.split(r"\s+", s0) if t]
    if not tokens:
        return None

    def _split_punct(tok: str) -> tuple[str, str, str]:
        prefix = ""
        while tok and (not tok[0].isalnum()):
            prefix += tok[0]
            tok = tok[1:]
        suffix = ""
        while tok and (not tok[-1].isalnum()):
            suffix = tok[-1] + suffix
            tok = tok[:-1]
        return prefix, tok, suffix

    def _cap_simple(word: str) -> str:
        if not word:
            return word
        w = word
        wl = w.lower()

        # Roman numerals.
        if wl in _ROMAN_NUMERALS:
            return wl.upper()

        # McXxxx heuristic.
        if wl.startswith("mc") and len(w) > 2 and w[2].isalpha():
            rest = w[2:]
            return "Mc" + rest[0].upper() + rest[1:].lower()

        # Basic title-case.
        return w[:1].upper() + w[1:].lower()

    def _cap_word(word: str) -> str:
        if not word:
            return word

        # Hyphenated parts.
        if "-" in word:
            return "-".join(_cap_word(p) for p in word.split("-"))

        # Apostrophe handling.
        wl = word.lower()
        if wl.startswith("d'") and len(word) > 2:
            return "d'" + _cap_word(word[2:])
        if wl.startswith("l'") and len(word) > 2:
            return "l'" + _cap_word(word[2:])
        if wl.startswith("o'") and len(word) > 2:
            return "O'" + _cap_word(word[2:])
        if "'" in word:
            parts = word.split("'")
            out_parts: list[str] = []
            for i, p in enumerate(parts):
                if not p:
                    out_parts.append("")
                    continue
                if i == 0 and len(p) == 1:
                    out_parts.append(p.upper())
                else:
                    out_parts.append(_cap_simple(p))
            return "'".join(out_parts)

        return _cap_simple(word)

    out_tokens: list[str] = []
    multi = len(tokens) > 1
    for idx, tok in enumerate(tokens):
        prefix, core, suffix = _split_punct(tok)
        if not core:
            out_tokens.append(tok)
            continue

        core_l = core.lower()
        if core_l in _NAME_LOWER_PARTICLES and multi:
            out_tokens.append(prefix + core_l + suffix)
            continue

        out_tokens.append(prefix + _cap_word(core) + suffix)

    return " ".join(out_tokens)


def _normalize_public_name_fields(
    *,
    display_name: str | None,
    given_name: str | None,
    surname: str | None,
) -> tuple[str | None, str | None]:
    """Normalize name fields for public/UI use.

    Gramps sometimes stores epithets like "(dragon)" inside the given name.
    If they drift into the surname column (exports/imports can be messy), we treat
    parenthetical-only surnames as an epithet and keep it in the given name.
    """

    s = (surname or "").strip()
    if not s:
        return given_name, surname

    if _PAREN_EPITHET_RE.match(s):
        dn = (display_name or "").strip()
        g = (given_name or "").strip()
        if dn:
            return dn, None
        if g:
            return f"{g} {s}".strip(), None
        return s, None

    return given_name, surname


def _format_public_person_names(
    *,
    display_name: str | None,
    given_name: str | None,
    surname: str | None,
) -> tuple[str | None, str | None, str | None]:
    given_name_out, surname_out = _normalize_public_name_fields(
        display_name=display_name,
        given_name=given_name,
        surname=surname,
    )
    return (
        _smart_title_case_name(display_name),
        _smart_title_case_name(given_name_out),
        _smart_title_case_name(surname_out),
    )


def _add_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        # Handle Feb 29 -> Feb 28 in non-leap years.
        return d.replace(month=2, day=28, year=d.year + years)


def _is_younger_than(birth: date, years: int, *, today: date | None = None) -> bool:
    t = today or date.today()
    return t < _add_years(birth, years)


def _is_effectively_living(
    *,
    is_living_override: bool | None,
    is_living: bool | None,
    death_date: date | None,
) -> bool | None:
    if is_living_override is not None:
        return bool(is_living_override)
    if is_living is not None:
        return bool(is_living)
    if death_date is not None:
        return False
    return None


def _is_effectively_private(
    *,
    is_private: bool | None,
    is_living_override: bool | None,
    is_living: bool | None,
    birth_date: date | None,
    death_date: date | None,
    birth_text: str | None = None,
    death_text: str | None = None,
) -> bool:
    """Privacy policy:

    - Explicitly private => private
    - If (effectively) living:
      - born >= 1946-01-01 => private
      - else if age < 90 => private
      - else public
    - Unknown birth date: privacy-first => private (for living/unknown living)
    """

    if bool(is_private):
        return True

    def _year_from_text(s: str | None) -> int | None:
        if not s:
            return None
        # Heuristic: look for any 4-digit year.
        # This intentionally keeps parsing simple and conservative.
        m = re.search(r"\b(\d{4})\b", str(s))
        if not m:
            return None
        try:
            y = int(m.group(1))
        except ValueError:
            return None
        # Avoid matching nonsense years.
        if y < 1 or y > date.today().year + 5:
            return None
        return y

    # If there's a credible death year in text, treat as not living.
    death_year = _year_from_text(death_text)
    death_date_hint = death_date
    if death_date_hint is None and death_year is not None:
        try:
            death_date_hint = date(death_year, 1, 1)
        except ValueError:
            death_date_hint = None

    living = _is_effectively_living(
        is_living_override=is_living_override,
        is_living=is_living,
        death_date=death_date_hint,
    )
    if living is False:
        return False

    # living is True or unknown
    birth_date_hint = birth_date
    if birth_date_hint is None:
        birth_year = _year_from_text(birth_text)
        if birth_year is not None:
            try:
                birth_date_hint = date(birth_year, 1, 1)
            except ValueError:
                birth_date_hint = None

    # Unknown birth date: privacy-first.
    if birth_date_hint is None:
        return True

    if birth_date_hint >= _PRIVACY_BORN_ON_OR_AFTER:
        return True
    if _is_younger_than(birth_date_hint, _PRIVACY_AGE_CUTOFF_YEARS):
        return True
    return False


_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


@app.get("/static/graph_demo.htm", include_in_schema=False)
def _static_graph_demo_htm_redirect() -> RedirectResponse:
    # Common typo/missing 'l'. Keep old links working.
    return RedirectResponse(url="/static/graph_demo.html", status_code=307)


@app.get("/demo/graph")
def demo_graph() -> FileResponse:
    """Interactive Cytoscape demo for the /graph/neighborhood endpoint."""

    path = _STATIC_DIR / "graph_demo.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="demo not found")
    return FileResponse(path)


@app.get("/demo/viewer")
def demo_viewer() -> FileResponse:
    """Starter Gramps-Web-like viewer shell (Graph + People + Events + Map tabs)."""

    # Viewer that ports the graph demo layout (graph_demo.html is kept as reference).
    path = _STATIC_DIR / "viewer_ported.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="viewer not found")
    return FileResponse(path)


@app.get("/demo/relationship")
def demo_relationship() -> FileResponse:
    """Relationship chart (Graphviz WASM) demo.

    Focused, modular frontend that renders a Gramps-Web-like relationship chart.
    """

    path = _STATIC_DIR / "relchart" / "index.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="demo not found")
    return FileResponse(path)


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


@app.get("/people")
def list_people(
    limit: int = Query(default=5000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
) -> dict[str, Any]:
    """List people in the database (privacy-redacted).

    This endpoint is intended for building a global People index in the UI.
    Use limit/offset pagination for large datasets.
    """

    with db_conn() as conn:
        total = None
        if include_total:
            total = conn.execute("SELECT COUNT(*) FROM person").fetchone()[0]

        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname,
                   birth_text, death_text, birth_date, death_date,
                   is_living, is_private, is_living_override
            FROM person
            ORDER BY display_name NULLS LAST, id
            LIMIT %s OFFSET %s
            """.strip(),
            (limit, offset),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for r in rows:
        (
            pid,
            gid,
            display_name,
            given_name,
            surname,
            birth_text,
            death_text,
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
        ) = tuple(r)

        def _year_hint(bd: date | None, dd: date | None, bt: str | None, dt: str | None) -> tuple[int | None, int | None]:
            by = bd.year if bd is not None else None
            dy = dd.year if dd is not None else None

            def _year_from_text(s: str | None) -> int | None:
                if not s:
                    return None
                m = re.search(r"\b(\d{4})\b", str(s))
                if not m:
                    return None
                try:
                    y = int(m.group(1))
                except ValueError:
                    return None
                if y < 1 or y > date.today().year + 5:
                    return None
                return y

            if by is None:
                by = _year_from_text(bt)
            if dy is None:
                dy = _year_from_text(dt)
            return by, dy

        if _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
            birth_text=birth_text,
            death_text=death_text,
        ):
            results.append(
                {
                    "id": pid,
                    "gramps_id": gid,
                    "type": "person",
                    "display_name": "Private",
                    "given_name": None,
                    "surname": None,
                    "birth_year": None,
                    "death_year": None,
                }
            )
        else:
            display_name_out, given_name_out, surname_out = _format_public_person_names(
                display_name=display_name,
                given_name=given_name,
                surname=surname,
            )
            by, dy = _year_hint(birth_date, death_date, birth_text, death_text)
            results.append(
                {
                    "id": pid,
                    "gramps_id": gid,
                    "type": "person",
                    "display_name": display_name_out,
                    "given_name": given_name_out,
                    "surname": surname_out,
                    "birth_year": by,
                    "death_year": dy,
                }
            )

    out: dict[str, Any] = {
        "offset": offset,
        "limit": limit,
        "results": results,
    }
    if include_total:
        out["total"] = int(total or 0)
    return out


@app.get("/families")
def list_families(
    limit: int = Query(default=5000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
) -> dict[str, Any]:
    """List families in the database (privacy-safe).

    Intended for building a global Families index in the UI.
    """

    with db_conn() as conn:
        total = None
        if include_total:
            total = conn.execute("SELECT COUNT(*) FROM family").fetchone()[0]

        rows = conn.execute(
            """
            SELECT f.id, f.gramps_id, f.father_id, f.mother_id, f.is_private,
                   COALESCE(ct.children_total, 0) AS children_total
            FROM family f
            LEFT JOIN (
              SELECT family_id, COUNT(*)::int AS children_total
              FROM family_child
              GROUP BY family_id
            ) ct ON ct.family_id = f.id
            ORDER BY f.gramps_id NULLS LAST, f.id
            LIMIT %s OFFSET %s
            """.strip(),
            (limit, offset),
        ).fetchall()

        # Gather parent ids for bulk lookup.
        parent_ids: set[str] = set()
        family_ids_public: list[str] = []
        for fid, fgid, fa, mo, fam_is_private, children_total in rows:
            if bool(fam_is_private):
                continue
            family_ids_public.append(str(fid))
            if fa:
                parent_ids.add(str(fa))
            if mo:
                parent_ids.add(str(mo))

        parents_by_id: dict[str, dict[str, Any]] = {}
        if parent_ids:
            parent_rows = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname, gender,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (list(parent_ids),),
            ).fetchall()
            for pr in parent_rows:
                p_public = _person_node_row_to_public(tuple(pr), distance=None)
                parents_by_id[str(p_public.get("id"))] = {
                    "id": p_public.get("id"),
                    "gramps_id": p_public.get("gramps_id"),
                    "display_name": p_public.get("display_name"),
                    "is_private": (p_public.get("display_name") == "Private"),
                }

        marriage_by_family: dict[str, str] = {}
        if family_ids_public:
            marriage_by_family = _fetch_family_marriage_date_map(conn, family_ids_public)

    results: list[dict[str, Any]] = []
    for fid, fgid, fa, mo, fam_is_private, children_total in rows:
        if bool(fam_is_private):
            results.append(
                {
                    "id": fid,
                    "gramps_id": None,
                    "is_private": True,
                    "father": None,
                    "mother": None,
                    "parents_total": None,
                    "children_total": 0,
                    "marriage": None,
                }
            )
            continue

        father = parents_by_id.get(str(fa)) if fa else None
        mother = parents_by_id.get(str(mo)) if mo else None
        parents_total = int(bool(fa)) + int(bool(mo))
        results.append(
            {
                "id": fid,
                "gramps_id": fgid,
                "is_private": False,
                "father": father,
                "mother": mother,
                "parents_total": parents_total,
                "children_total": int(children_total or 0),
                "marriage": marriage_by_family.get(str(fid)),
            }
        )

    out: dict[str, Any] = {
        "offset": offset,
        "limit": limit,
        "results": results,
    }
    if include_total:
        out["total"] = int(total or 0)
    return out


@app.get("/events")
def list_events(
    limit: int = Query(default=500, ge=1, le=5_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    include_total: bool = False,
    q: Optional[str] = None,
    place_id: Optional[str] = None,
    sort: str = "type_asc",
) -> dict[str, Any]:
    """List events in the database (privacy-safe).

    Notes:
    - Events with `event.is_private` are always hidden.
    - Additionally, events connected to any effectively-private person (or to any
      family that is private / has an effectively-private parent) are omitted.
    - Places that are private are redacted (place=null).

    This endpoint exists to power a global Events index in the UI.
    """

    with db_conn() as conn:
        def _has_col(table: str, col: str) -> bool:
            try:
                row = conn.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = %s AND column_name = %s
                    LIMIT 1
                    """.strip(),
                    (table, col),
                ).fetchone()
                return bool(row)
            except Exception:
                return False

        has_event_gramps_id = _has_col("event", "gramps_id")

        qn = (q or "").strip()
        q_like = f"%{qn}%" if qn else None

        pid = (place_id or "").strip() or None

        gramps_id_select = "e.gramps_id" if has_event_gramps_id else "NULL"

        sort_key = (sort or "type_asc").strip().lower()
        id_expr = f"COALESCE({gramps_id_select}, e.id)"
        base_order_by = {
            "type_asc": f"e.event_type NULLS LAST, e.event_date NULLS LAST, e.event_date_text NULLS LAST, {id_expr} NULLS LAST, e.id",
            "type_desc": f"e.event_type DESC NULLS LAST, e.event_date NULLS LAST, e.event_date_text NULLS LAST, {id_expr} NULLS LAST, e.id",
            "year_asc": f"(e.event_date IS NULL) ASC, e.event_date ASC, e.event_date_text NULLS LAST, e.event_type NULLS LAST, {id_expr} NULLS LAST, e.id",
            "year_desc": f"(e.event_date IS NULL) ASC, e.event_date DESC, e.event_date_text NULLS LAST, e.event_type NULLS LAST, {id_expr} NULLS LAST, e.id",
            "id_asc": f"{id_expr} NULLS LAST, e.id",
            "id_desc": f"{id_expr} DESC NULLS LAST, e.id",
        }.get(sort_key, f"e.event_type NULLS LAST, e.event_date NULLS LAST, e.event_date_text NULLS LAST, {id_expr} NULLS LAST, e.id")

        total = None
        if include_total:
            if q_like:
                if has_event_gramps_id:
                    total = conn.execute(
                        """
                        SELECT COUNT(*)
                        FROM event e
                        LEFT JOIN place pl ON pl.id = e.place_id
                        WHERE e.is_private = FALSE
                          AND (%s::text IS NULL OR e.place_id = %s::text)
                          AND (
                            e.event_type ILIKE %s
                            OR e.description ILIKE %s
                            OR e.event_date_text ILIKE %s
                            OR e.gramps_id ILIKE %s
                            OR pl.name ILIKE %s
                                                        OR EXISTS (
                                                            SELECT 1
                                                            FROM person_event pe
                                                            JOIN person p ON p.id = pe.person_id
                                                            WHERE pe.event_id = e.id
                                                                AND (
                                                                    p.display_name ILIKE %s
                                                                    OR p.given_name ILIKE %s
                                                                    OR p.surname ILIKE %s
                                                                    OR p.gramps_id ILIKE %s
                                                                )
                                                        )
                          )
                        """.strip(),
                                                (pid, pid, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like),
                    ).fetchone()[0]
                else:
                    total = conn.execute(
                        """
                        SELECT COUNT(*)
                        FROM event e
                        LEFT JOIN place pl ON pl.id = e.place_id
                        WHERE e.is_private = FALSE
                          AND (%s::text IS NULL OR e.place_id = %s::text)
                          AND (
                            e.event_type ILIKE %s
                            OR e.description ILIKE %s
                            OR e.event_date_text ILIKE %s
                            OR pl.name ILIKE %s
                                                        OR EXISTS (
                                                            SELECT 1
                                                            FROM person_event pe
                                                            JOIN person p ON p.id = pe.person_id
                                                            WHERE pe.event_id = e.id
                                                                AND (
                                                                    p.display_name ILIKE %s
                                                                    OR p.given_name ILIKE %s
                                                                    OR p.surname ILIKE %s
                                                                    OR p.gramps_id ILIKE %s
                                                                )
                                                        )
                          )
                        """.strip(),
                                                (pid, pid, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like),
                    ).fetchone()[0]
            else:
                total = conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM event e
                    WHERE e.is_private = FALSE
                      AND (%s::text IS NULL OR e.place_id = %s::text)
                    """.strip(),
                    (pid, pid),
                ).fetchone()[0]

        page_limit = int(limit)
        page_offset = int(offset)
        page_plus = page_limit + 1

        base_where = "e.is_private = FALSE"
        params: list[Any] = []
        if pid:
            base_where += " AND e.place_id = %s"
            params.append(pid)
        if q_like:
            if has_event_gramps_id:
                base_where += " AND (e.event_type ILIKE %s OR e.description ILIKE %s OR e.event_date_text ILIKE %s OR e.gramps_id ILIKE %s OR pl.name ILIKE %s OR EXISTS (SELECT 1 FROM person_event pe JOIN person p ON p.id = pe.person_id WHERE pe.event_id = e.id AND (p.display_name ILIKE %s OR p.given_name ILIKE %s OR p.surname ILIKE %s OR p.gramps_id ILIKE %s)))"
                params.extend([q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like])
            else:
                base_where += " AND (e.event_type ILIKE %s OR e.description ILIKE %s OR e.event_date_text ILIKE %s OR pl.name ILIKE %s OR EXISTS (SELECT 1 FROM person_event pe JOIN person p ON p.id = pe.person_id WHERE pe.event_id = e.id AND (p.display_name ILIKE %s OR p.given_name ILIKE %s OR p.surname ILIKE %s OR p.gramps_id ILIKE %s)))"
                params.extend([q_like, q_like, q_like, q_like, q_like, q_like, q_like, q_like])

        rows = conn.execute(
            f"""
            WITH base AS (
              SELECT
                e.id,
                {gramps_id_select} AS gramps_id,
                e.event_type,
                e.description,
                e.event_date_text,
                e.event_date,
                pl.id as place_id,
                pl.name as place_name,
                pl.is_private as place_is_private
              FROM event e
              LEFT JOIN place pl ON pl.id = e.place_id
              WHERE {base_where}
              ORDER BY {base_order_by}
              LIMIT %s OFFSET %s
            ),
            pe AS (
              SELECT
                pe.event_id,
                array_agg(pe.person_id ORDER BY pe.person_id) AS person_ids,
                array_agg(COALESCE(pe.role, '') ORDER BY pe.person_id) AS person_roles
              FROM person_event pe
              WHERE pe.event_id IN (SELECT id FROM base)
              GROUP BY pe.event_id
            ),
            fe AS (
              SELECT
                fe.event_id,
                array_agg(fe.family_id ORDER BY fe.family_id) AS family_ids
              FROM family_event fe
              WHERE fe.event_id IN (SELECT id FROM base)
              GROUP BY fe.event_id
            ),
            pf AS (
              SELECT DISTINCT ON (fe.event_id)
                fe.event_id,
                f.father_id AS primary_family_father_id
              FROM family_event fe
              JOIN family f ON f.id = fe.family_id
              WHERE fe.event_id IN (SELECT id FROM base)
              ORDER BY fe.event_id, f.gramps_id NULLS LAST, f.id
            )
            SELECT
              b.id,
              b.gramps_id,
              b.event_type,
              b.description,
              b.event_date_text,
              b.event_date,
              b.place_id,
              b.place_name,
              b.place_is_private,
              COALESCE(pe.person_ids, ARRAY[]::text[]) AS person_ids,
              COALESCE(pe.person_roles, ARRAY[]::text[]) AS person_roles,
              COALESCE(fe.family_ids, ARRAY[]::text[]) AS family_ids,
              pf.primary_family_father_id
            FROM base b
            LEFT JOIN pe ON pe.event_id = b.id
            LEFT JOIN fe ON fe.event_id = b.id
            LEFT JOIN pf ON pf.event_id = b.id
            ORDER BY {base_order_by.replace('e.', 'b.')}
            """.strip(),
            [*params, page_plus, page_offset],
        ).fetchall()

        has_more = len(rows) > page_limit
        if has_more:
            rows = rows[:page_limit]

        # Gather referenced ids for bulk privacy checks.
        person_ids: set[str] = set()
        family_ids: set[str] = set()
        for r in rows:
            pe_ids = r[9] or []
            fe_ids = r[11] or []
            for pid in pe_ids:
                if pid:
                    person_ids.add(str(pid))
            for fid in fe_ids:
                if fid:
                    family_ids.add(str(fid))
            pf0 = r[12]
            if pf0:
                person_ids.add(str(pf0))

        families_by_id: dict[str, dict[str, Any]] = {}
        family_parent_ids: set[str] = set()
        if family_ids:
            fam_rows = conn.execute(
                """
                SELECT id, father_id, mother_id, is_private
                FROM family
                WHERE id = ANY(%s)
                """.strip(),
                (list(family_ids),),
            ).fetchall()
            for fid, fa, mo, fam_is_private in fam_rows:
                fid_s = str(fid)
                families_by_id[fid_s] = {
                    "id": fid_s,
                    "father_id": str(fa) if fa else None,
                    "mother_id": str(mo) if mo else None,
                    "is_private": bool(fam_is_private),
                }
                if fa:
                    family_parent_ids.add(str(fa))
                if mo:
                    family_parent_ids.add(str(mo))

        all_people_ids = set(person_ids) | set(family_parent_ids)
        person_private_by_id: dict[str, bool] = {}
        person_public_by_id: dict[str, dict[str, Any]] = {}
        if all_people_ids:
            pr = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (list(all_people_ids),),
            ).fetchall()
            for (
                pid,
                gid,
                display_name,
                given_name,
                surname,
                birth_text,
                death_text,
                birth_date,
                death_date,
                is_living_flag,
                is_private_flag,
                is_living_override,
            ) in pr:
                pid_s = str(pid)
                is_private_eff = _is_effectively_private(
                    is_private=is_private_flag,
                    is_living_override=is_living_override,
                    is_living=is_living_flag,
                    birth_date=birth_date,
                    death_date=death_date,
                    birth_text=birth_text,
                    death_text=death_text,
                )

                person_private_by_id[pid_s] = bool(is_private_eff)
                if not bool(is_private_eff):
                    display_name_out, given_name_out, surname_out = _format_public_person_names(
                        display_name=display_name,
                        given_name=given_name,
                        surname=surname,
                    )
                    person_public_by_id[pid_s] = {
                        "id": pid_s,
                        "gramps_id": gid,
                        "display_name": display_name_out,
                        "given_name": given_name_out,
                        "surname": surname_out,
                    }

    results: list[dict[str, Any]] = []
    for r in rows:
        (
            eid,
            e_gramps_id,
            event_type,
            description,
            event_date_text,
            event_date,
            place_id,
            place_name,
            place_is_private,
            pe_ids,
            pe_roles,
            fe_ids,
            primary_family_father_id,
        ) = tuple(r)

        pe_list = [str(x) for x in (pe_ids or []) if x]
        if any(person_private_by_id.get(pid, False) for pid in pe_list):
            continue

        fe_list = [str(x) for x in (fe_ids or []) if x]
        family_ok = True
        for fid in fe_list:
            fam = families_by_id.get(fid)
            if not fam:
                family_ok = False
                break
            if bool(fam.get("is_private")):
                family_ok = False
                break
            fa = fam.get("father_id")
            mo = fam.get("mother_id")
            if (fa and person_private_by_id.get(str(fa), False)) or (mo and person_private_by_id.get(str(mo), False)):
                family_ok = False
                break
        if not family_ok:
            continue

        primary_pid: str | None = None
        if primary_family_father_id:
            primary_pid = str(primary_family_father_id)
        else:
            roles = [str(x or "").strip() for x in (pe_roles or [])]
            pairs = list(zip(pe_list, roles))

            def _role_rank(role_raw: str) -> int:
                r0 = (role_raw or "").strip().lower()
                if not r0:
                    return 50
                if "husband" in r0:
                    return 0
                if "father" in r0:
                    return 1
                if "primary" in r0 or "principal" in r0 or "main" in r0:
                    return 2
                return 10

            pairs.sort(key=lambda pr: (_role_rank(pr[1]), pr[0]))
            if pairs:
                primary_pid = pairs[0][0]

        primary_person = person_public_by_id.get(str(primary_pid)) if primary_pid else None

        place_out = None
        if place_id and not bool(place_is_private):
            place_out = {"id": place_id, "name": place_name}

        results.append(
            {
                "id": eid,
                "gramps_id": e_gramps_id,
                "type": event_type,
                "date": event_date.isoformat() if isinstance(event_date, date) else None,
                "date_text": event_date_text,
                "description": description,
                "place": place_out,
                "people_total": len(pe_list),
                "families_total": len(fe_list),
                "primary_person": primary_person,
            }
        )

    next_offset = (page_offset + page_limit) if has_more else None
    out: dict[str, Any] = {
        "offset": offset,
        "limit": limit,
        "results": results,
        "has_more": bool(has_more),
        "next_offset": next_offset,
    }
    if include_total:
        out["total"] = int(total or 0)
    return _compact_json(out) or out


@app.get("/places/events_counts")
def places_events_counts() -> dict[str, Any]:
        """Return per-place event counts (privacy-safe).

        Used by the Map tab to decide whether to show the per-place events menu.

        Notes:
        - Counts only include events where event.is_private = FALSE.
        - Only includes non-private places.
        """

        with db_conn() as conn:
                rows = conn.execute(
                        """
                        SELECT
                            e.place_id AS place_id,
                            COUNT(*)::int AS events_total
                        FROM event e
                        JOIN place p ON p.id = e.place_id
                        WHERE e.is_private = FALSE
                            AND p.is_private = FALSE
                            AND e.place_id IS NOT NULL
                        GROUP BY e.place_id
                        """.strip()
                ).fetchall()

        results = [{"place_id": str(pid), "events_total": int(n)} for (pid, n) in rows]
        out: dict[str, Any] = {"results": results}
        return _compact_json(out) or out


@app.get("/places")
def list_places(
    limit: int = Query(default=50_000, ge=1, le=50_000),
    offset: int = Query(default=0, ge=0, le=5_000_000),
    q: Optional[str] = None,
) -> dict[str, Any]:
    """List places in the database (privacy-safe).

    Notes:
    - Places with `place.is_private` are always hidden.
    - This is a global index used by the Map tab (hierarchical place list).
    """

    qn = (q or "").strip()
    q_like = f"%{qn}%" if qn else None

    with db_conn() as conn:
        def _has_col(table: str, col: str) -> bool:
            try:
                row = conn.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = %s AND column_name = %s
                    LIMIT 1
                    """.strip(),
                    (table, col),
                ).fetchone()
                return bool(row)
            except Exception:
                return False

        has_place_gramps_id = _has_col("place", "gramps_id")
        has_place_type = _has_col("place", "place_type")
        has_enclosed_by = _has_col("place", "enclosed_by_id")

        gramps_id_select = "p.gramps_id" if has_place_gramps_id else "NULL"
        type_select = "p.place_type" if has_place_type else "NULL"
        enclosed_by_select = "p.enclosed_by_id" if has_enclosed_by else "NULL"

        where = "p.is_private = FALSE"
        params: list[Any] = []
        if q_like:
            where += f" AND (p.name ILIKE %s OR {gramps_id_select} ILIKE %s OR {type_select} ILIKE %s)"
            params.extend([q_like, q_like, q_like])

        rows = conn.execute(
            f"""
            SELECT
              p.id,
              {gramps_id_select} AS gramps_id,
              p.name,
              {type_select} AS place_type,
              {enclosed_by_select} AS enclosed_by_id,
              p.lat,
              p.lon
            FROM place p
            WHERE {where}
            ORDER BY COALESCE({gramps_id_select}, p.name) NULLS LAST, p.id
            LIMIT %s OFFSET %s
            """.strip(),
            [*params, limit, offset],
        ).fetchall()

        by_id: dict[str, dict[str, Any]] = {}
        results: list[dict[str, Any]] = []
        for (pid, gramps_id, name, place_type, enclosed_by_id, lat, lon) in rows:
            rec = {
                "id": str(pid),
                "gramps_id": gramps_id,
                "name": name,
                "type": place_type,
                "enclosed_by_id": enclosed_by_id,
                "lat": lat,
                "lon": lon,
            }
            by_id[rec["id"]] = rec
            results.append(rec)

        # If this page window doesn't include parents, fetch missing ancestors so
        # the UI can still show an enclosure chain. This is bounded and only walks
        # upward via enclosed_by_id.
        if has_enclosed_by and results:
            to_fetch: set[str] = set()
            for rec in results:
                pid = rec.get("enclosed_by_id")
                if pid:
                    to_fetch.add(str(pid))

            depth = 0
            while to_fetch and depth < 16:
                batch = [pid for pid in to_fetch if pid not in by_id]
                to_fetch = set()
                if not batch:
                    break

                anc_rows = conn.execute(
                    f"""
                    SELECT
                      p.id,
                      {gramps_id_select} AS gramps_id,
                      p.name,
                      {type_select} AS place_type,
                      {enclosed_by_select} AS enclosed_by_id
                    FROM place p
                    WHERE p.is_private = FALSE AND p.id = ANY(%s)
                    """.strip(),
                    (batch,),
                ).fetchall()

                for (pid, gramps_id, name, place_type, enclosed_by_id) in anc_rows:
                    rec = {
                        "id": str(pid),
                        "gramps_id": gramps_id,
                        "name": name,
                        "type": place_type,
                        "enclosed_by_id": enclosed_by_id,
                        "lat": None,
                        "lon": None,
                    }
                    by_id[rec["id"]] = rec

                    nxt = rec.get("enclosed_by_id")
                    if nxt:
                        nxt = str(nxt)
                        if nxt not in by_id:
                            to_fetch.add(nxt)

                depth += 1

        # Add enclosure chain for each returned place.
        enclosure_cache: dict[str, list[dict[str, Any]]] = {}

        def _enclosure_for(pid: str) -> list[dict[str, Any]]:
            if pid in enclosure_cache:
                return enclosure_cache[pid]
            out: list[dict[str, Any]] = []
            seen: set[str] = set()
            cur = by_id.get(pid)
            while cur:
                parent_id = cur.get("enclosed_by_id")
                if not parent_id:
                    break
                parent_id = str(parent_id)
                if parent_id in seen:
                    break
                seen.add(parent_id)
                parent = by_id.get(parent_id)
                if not parent:
                    break
                out.append(
                    {
                        "id": parent.get("id"),
                        "gramps_id": parent.get("gramps_id"),
                        "name": parent.get("name"),
                        "type": parent.get("type"),
                    }
                )
                cur = parent
            enclosure_cache[pid] = out
            return out

        for rec in results:
            rec["enclosure"] = _enclosure_for(rec["id"])

    return _compact_json({"offset": offset, "limit": limit, "results": results}) or {
        "offset": offset,
        "limit": limit,
        "results": results,
    }


def _resolve_person_id(person_ref: str) -> str:
    """Resolve either an internal handle (_abc...) or a Gramps ID (I0001) to the internal handle."""

    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT id
            FROM person
            WHERE id = %s OR gramps_id = %s
            LIMIT 1
            """.strip(),
            (person_ref, person_ref),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"person not found: {person_ref}")
    return row[0]


@app.get("/people/{person_id}")
def get_person(person_id: str) -> dict[str, Any]:
    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")

    resolved_id = _resolve_person_id(person_id)

    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname, gender,
                   birth_text, death_text, birth_date, death_date,
                   is_living, is_private, is_living_override
            FROM person
            WHERE id = %s
            """.strip(),
            (resolved_id,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="person not found")

    (
        pid,
        gid,
        display_name,
        given_name,
        surname,
        gender,
        birth_text,
        death_text,
        birth_date,
        death_date,
        is_living_flag,
        is_private_flag,
        is_living_override,
    ) = tuple(row)

    person = {
        "id": pid,
        "gramps_id": gid,
        "display_name": display_name,
        "given_name": given_name,
        "surname": surname,
        "gender": gender,
        "birth_text": birth_text,
        "death_text": death_text,
        "is_living": is_living_flag,
        "is_private": is_private_flag,
    }

    should_redact = _is_effectively_private(
        is_private=person.get("is_private"),
        is_living_override=is_living_override,
        is_living=person.get("is_living"),
        birth_date=birth_date,
        death_date=death_date,
    )

    # Enforce privacy even if upstream export forgot.
    if should_redact:
        living_effective = _is_effectively_living(
            is_living_override=is_living_override,
            is_living=person.get("is_living"),
            death_date=death_date,
        )
        return {
            "id": person["id"],
            "gramps_id": person.get("gramps_id"),
            "display_name": "Private",
            "given_name": None,
            "surname": None,
            "gender": None,
            "birth": None,
            "death": None,
            "is_living": True if living_effective is None else bool(living_effective),
            "is_private": True,
        }

    display_name_out, given_name_out, surname_out = _format_public_person_names(
        display_name=person.get("display_name"),
        given_name=person.get("given_name"),
        surname=person.get("surname"),
    )

    return {
        "id": person["id"],
        "gramps_id": person.get("gramps_id"),
        "display_name": display_name_out,
        "given_name": given_name_out,
        "surname": surname_out,
        "gender": person.get("gender"),
        "birth": person.get("birth_text"),
        "death": person.get("death_text"),
        "is_living": bool(person.get("is_living")) if person.get("is_living") is not None else None,
        "is_private": bool(person.get("is_private")),
    }


def _compact_json(value: Any) -> Any:
    """Recursively remove null/empty fields from JSON-like structures.

    Rules:
    - Drop keys with None
    - Drop keys with empty string (after strip)
    - Drop keys with empty list/dict
    - Keep 0/False
    """

    if value is None:
        return None

    if isinstance(value, str):
        s = value.strip()
        return s if s else None

    if isinstance(value, list):
        out_list = []
        for item in value:
            v = _compact_json(item)
            if v is None:
                continue
            out_list.append(v)
        return out_list if out_list else None

    if isinstance(value, dict):
        out_dict: dict[str, Any] = {}
        for k, v in value.items():
            vv = _compact_json(v)
            if vv is None:
                continue
            out_dict[k] = vv
        return out_dict if out_dict else None

    return value


@app.get("/people/{person_id}/details")
def get_person_details(person_id: str) -> dict[str, Any]:
    """Richer person payload for the UI detail panel.

    Returns:
    - person: same privacy-redacted core as /people/{id}
    - events: events attached to person (privacy-filtered)
    - gramps_notes: notes attached to person (privacy-filtered)

    Future tabs (placeholders): user_notes, media, sources, other.
    """

    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")

    resolved_id = _resolve_person_id(person_id)
    person_core = get_person(resolved_id)

    # If person is private/redacted, don't leak associated edges/notes.
    if bool(person_core.get("is_private")) or person_core.get("display_name") == "Private":
        out = {
            "person": person_core,
            "events": [],
            "gramps_notes": [],
            "user_notes": [],
            "media": [],
            "sources": [],
            "other": {},
        }
        return _compact_json(out) or {"person": person_core}

    with db_conn() as conn:
        def _has_col(table: str, col: str) -> bool:
            try:
                row = conn.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = %s AND column_name = %s
                    LIMIT 1
                    """.strip(),
                    (table, col),
                ).fetchone()
                return bool(row)
            except Exception:
                return False

        has_event_gramps_id = _has_col("event", "gramps_id")

        # Person events
        gramps_id_select = "e.gramps_id" if has_event_gramps_id else "NULL"
        ev_rows = conn.execute(
            f"""
            SELECT
              e.id,
              {gramps_id_select} AS gramps_id,
              e.event_type,
              e.description,
              e.event_date_text,
              e.event_date,
              e.is_private,
              pe.role,
              pl.id as place_id,
              pl.name as place_name,
              pl.is_private as place_is_private
            FROM person_event pe
            JOIN event e ON e.id = pe.event_id
            LEFT JOIN place pl ON pl.id = e.place_id
            WHERE pe.person_id = %s
            ORDER BY e.event_date NULLS LAST, e.event_date_text NULLS LAST, e.event_type NULLS LAST, e.id
            """.strip(),
            (resolved_id,),
        ).fetchall()

        events: list[dict[str, Any]] = []
        event_ids: list[str] = []
        for r in ev_rows:
            (
                eid,
                e_gramps_id,
                event_type,
                description,
                event_date_text,
                event_date,
                event_is_private,
                role,
                place_id,
                place_name,
                place_is_private,
            ) = tuple(r)

            if bool(event_is_private):
                continue

            event_ids.append(str(eid))
            place_out = None
            if place_id and (not bool(place_is_private)):
                place_out = {"id": place_id, "name": place_name}

            events.append(
                {
                    "id": eid,
                    "gramps_id": e_gramps_id,
                    "type": event_type,
                    "role": role,
                    "date": event_date.isoformat() if isinstance(event_date, date) else None,
                    "date_text": event_date_text,
                    "description": description,
                    "place": place_out,
                }
            )

        # Notes attached directly to the person (Gramps Notes tab)
        note_rows = conn.execute(
            """
            SELECT n.id, n.body, n.is_private
            FROM person_note pn
            JOIN note n ON n.id = pn.note_id
            WHERE pn.person_id = %s
            ORDER BY n.id
            """.strip(),
            (resolved_id,),
        ).fetchall()

        gramps_notes: list[dict[str, Any]] = []
        for nr in note_rows:
            nid, body, is_private = tuple(nr)
            if bool(is_private):
                continue
            gramps_notes.append({"id": nid, "body": body})

        # Optional: attach event notes (if present) into the event objects.
        if event_ids:
            ev_note_rows = conn.execute(
                """
                SELECT en.event_id, n.id, n.body, n.is_private
                FROM event_note en
                JOIN note n ON n.id = en.note_id
                WHERE en.event_id = ANY(%s)
                ORDER BY en.event_id, n.id
                """.strip(),
                (event_ids,),
            ).fetchall()

            notes_by_event: dict[str, list[dict[str, Any]]] = {}
            for er in ev_note_rows:
                ev_id, nid, body, is_private = tuple(er)
                if bool(is_private):
                    continue
                notes_by_event.setdefault(str(ev_id), []).append({"id": nid, "body": body})

            if notes_by_event:
                for ev in events:
                    ev_id = str(ev.get("id") or "")
                    if not ev_id:
                        continue
                    if ev_id in notes_by_event:
                        ev["notes"] = notes_by_event[ev_id]

    out = {
        "person": person_core,
        "events": events,
        "gramps_notes": gramps_notes,
        "user_notes": [],
        "media": [],
        "sources": [],
        "other": {},
    }
    return _compact_json(out) or {"person": person_core}


def _people_core_many(conn: psycopg.Connection, person_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch privacy-redacted core person payloads for many internal person ids."""

    if not person_ids:
        return {}

    rows = conn.execute(
        """
        SELECT id, gramps_id, display_name, given_name, surname, gender,
               birth_text, death_text, birth_date, death_date,
               is_living, is_private, is_living_override
        FROM person
        WHERE id = ANY(%s)
        """.strip(),
        (person_ids,),
    ).fetchall()

    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        (
            pid,
            gid,
            display_name,
            given_name,
            surname,
            gender,
            birth_text,
            death_text,
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
        ) = tuple(r)

        should_redact = _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
        )

        if should_redact:
            living_effective = _is_effectively_living(
                is_living_override=is_living_override,
                is_living=is_living_flag,
                death_date=death_date,
            )
            out[str(pid)] = {
                "id": pid,
                "gramps_id": gid,
                "display_name": "Private",
                "given_name": None,
                "surname": None,
                "gender": None,
                "birth": None,
                "death": None,
                "is_living": True if living_effective is None else bool(living_effective),
                "is_private": True,
            }
            continue

        display_name_out, given_name_out, surname_out = _format_public_person_names(
            display_name=display_name,
            given_name=given_name,
            surname=surname,
        )

        out[str(pid)] = {
            "id": pid,
            "gramps_id": gid,
            "display_name": display_name_out,
            "given_name": given_name_out,
            "surname": surname_out,
            "gender": gender,
            "birth": birth_text,
            "death": death_text,
            "is_living": bool(is_living_flag) if is_living_flag is not None else None,
            "is_private": bool(is_private_flag),
        }

    return out


@app.get("/people/{person_id}/relations")
def get_person_relations(person_id: str) -> dict[str, Any]:
    """Relationship-style payload for the UI Relations tab (Gramps-like).

    Returns:
    - person: same privacy-redacted core as /people/{id}
    - parents: list[person]
    - siblings: list[person]
    - families: list[{ id, gramps_id, spouse: person|null, children: list[person] }]
    """

    if not person_id:
        raise HTTPException(status_code=400, detail="missing person_id")

    resolved_id = _resolve_person_id(person_id)
    person_core = get_person(resolved_id)

    # If person is private/redacted, don't leak relationship graph.
    if bool(person_core.get("is_private")) or person_core.get("display_name") == "Private":
        out = {
            "person": person_core,
            "parents": [],
            "siblings": [],
            "families": [],
        }
        return _compact_json(out) or {"person": person_core}

    with db_conn() as conn:
        # Parents from person_parent (direct edges)
        parent_ids_pp = [str(r[0]) for r in conn.execute(
            "SELECT parent_id FROM person_parent WHERE child_id = %s",
            (resolved_id,),
        ).fetchall()]

        # Families where person is a child
        fam_as_child = [str(r[0]) for r in conn.execute(
            "SELECT family_id FROM family_child WHERE child_id = %s",
            (resolved_id,),
        ).fetchall()]

        parent_ids_family: list[str] = []
        sibling_ids_family: list[str] = []
        if fam_as_child:
            fam_rows = conn.execute(
                """
                SELECT id, father_id, mother_id, is_private
                FROM family
                WHERE id = ANY(%s)
                """.strip(),
                (fam_as_child,),
            ).fetchall()

            # Parents via family father/mother, and siblings via family children.
            for fid, fa, mo, fam_is_private in fam_rows:
                if bool(fam_is_private):
                    continue
                if fa:
                    parent_ids_family.append(str(fa))
                if mo:
                    parent_ids_family.append(str(mo))

            sib_rows = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = ANY(%s)
                """.strip(),
                (fam_as_child,),
            ).fetchall()
            for fid, cid in sib_rows:
                if str(cid) != str(resolved_id):
                    sibling_ids_family.append(str(cid))

        # Siblings via shared parents (person_parent) as a fallback / for half-siblings.
        parent_ids_all = set(parent_ids_pp) | set(parent_ids_family)
        sibling_ids_pp: list[str] = []
        if parent_ids_all:
            sib_pp_rows = conn.execute(
                """
                SELECT DISTINCT child_id
                FROM person_parent
                WHERE parent_id = ANY(%s)
                """.strip(),
                (list(parent_ids_all),),
            ).fetchall()
            for (cid,) in sib_pp_rows:
                if str(cid) != str(resolved_id):
                    sibling_ids_pp.append(str(cid))

        # Families where person is a parent
        fam_as_parent_rows = conn.execute(
            """
            SELECT id, gramps_id, father_id, mother_id, is_private
            FROM family
            WHERE father_id = %s OR mother_id = %s
            ORDER BY gramps_id NULLS LAST, id
            """.strip(),
            (resolved_id, resolved_id),
        ).fetchall()

        fam_ids_as_parent = [str(r[0]) for r in fam_as_parent_rows if not bool(r[4])]
        children_by_family: dict[str, list[str]] = {}
        if fam_ids_as_parent:
            fc_rows = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = ANY(%s)
                ORDER BY family_id, child_id
                """.strip(),
                (fam_ids_as_parent,),
            ).fetchall()
            for fid, cid in fc_rows:
                children_by_family.setdefault(str(fid), []).append(str(cid))

        # Gather all referenced people ids for one bulk privacy-redacted fetch.
        parent_ids = sorted({*parent_ids_all} - {str(resolved_id)})
        sibling_ids = sorted({*sibling_ids_family, *sibling_ids_pp} - {str(resolved_id)})

        spouse_ids: set[str] = set()
        child_ids: set[str] = set()
        for fid, gid, fa, mo, fam_is_private in fam_as_parent_rows:
            if bool(fam_is_private):
                continue
            other = None
            if fa and str(fa) != str(resolved_id):
                other = str(fa)
            if mo and str(mo) != str(resolved_id):
                other = str(mo)
            if other:
                spouse_ids.add(other)
            for cid in children_by_family.get(str(fid), []):
                child_ids.add(str(cid))

        all_people_ids = sorted({*parent_ids, *sibling_ids, *spouse_ids, *child_ids})
        people_by_id = _people_core_many(conn, all_people_ids)

        parents_out = [people_by_id[i] for i in parent_ids if i in people_by_id]
        siblings_out = [people_by_id[i] for i in sibling_ids if i in people_by_id]

        families_out: list[dict[str, Any]] = []
        for fid, gid, fa, mo, fam_is_private in fam_as_parent_rows:
            if bool(fam_is_private):
                continue
            fid_s = str(fid)
            spouse_id = None
            if fa and str(fa) != str(resolved_id):
                spouse_id = str(fa)
            if mo and str(mo) != str(resolved_id):
                spouse_id = str(mo)
            spouse_out = people_by_id.get(spouse_id) if spouse_id else None
            kids = [people_by_id[cid] for cid in children_by_family.get(fid_s, []) if cid in people_by_id]
            families_out.append(
                {
                    "id": fid_s,
                    "gramps_id": gid,
                    "spouse": spouse_out,
                    "children": kids,
                }
            )

    out = {
        "person": person_core,
        "parents": parents_out,
        "siblings": siblings_out,
        "families": families_out,
    }
    return _compact_json(out) or {"person": person_core}


@app.get("/people/search")
def search_people(q: str = Query(min_length=1, max_length=200)) -> dict[str, Any]:
    q_like = f"%{q}%"
    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name,
                   birth_date, death_date, is_living, is_private, is_living_override
            FROM person
            WHERE display_name ILIKE %s
            ORDER BY display_name
            LIMIT 25
            """.strip(),
            (q_like,),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for r in rows:
        (
            pid,
            gid,
            display_name,
            birth_date,
            death_date,
            is_living_flag,
            is_private_flag,
            is_living_override,
        ) = tuple(r)

        # Always redact per privacy policy.
        if _is_effectively_private(
            is_private=is_private_flag,
            is_living_override=is_living_override,
            is_living=is_living_flag,
            birth_date=birth_date,
            death_date=death_date,
        ):
            results.append({"id": r[0], "gramps_id": r[1], "display_name": "Private"})
        else:
            results.append({"id": r[0], "gramps_id": r[1], "display_name": _smart_title_case_name(r[2])})

    return {"query": q, "results": results}


def _fetch_neighbors(conn: psycopg.Connection, node_ids: list[str]) -> dict[str, list[str]]:
    if not node_ids:
        return {}

    out: dict[str, list[str]] = {nid: [] for nid in node_ids}

    # Parents
    for child_id, parent_id in conn.execute(
        "SELECT child_id, parent_id FROM person_parent WHERE child_id = ANY(%s)",
        (node_ids,),
    ).fetchall():
        out.setdefault(child_id, []).append(parent_id)

    # Children
    for parent_id, child_id in conn.execute(
        "SELECT parent_id, child_id FROM person_parent WHERE parent_id = ANY(%s)",
        (node_ids,),
    ).fetchall():
        out.setdefault(parent_id, []).append(child_id)

    return out


def _fetch_spouses(conn: psycopg.Connection, node_ids: list[str]) -> dict[str, list[str]]:
    """Return person->list(spouse/partner person_ids) for any family where they are a parent.

    Note: We treat spouse links as "same generation" (depth cost 0) and we *do not*
    expand further through spouse links during neighborhood BFS to avoid pulling in
    large lateral marriage networks.
    """

    if not node_ids:
        return {}

    out: dict[str, list[str]] = {nid: [] for nid in node_ids}

    # Spouses/partners are inferred via family rows with both parents set.
    rows = conn.execute(
        """
        SELECT father_id, mother_id
        FROM family
        WHERE father_id IS NOT NULL
          AND mother_id IS NOT NULL
          AND (father_id = ANY(%s) OR mother_id = ANY(%s))
        """.strip(),
        (node_ids, node_ids),
    ).fetchall()

    for father_id, mother_id in rows:
        if father_id in out:
            out[father_id].append(mother_id)
        if mother_id in out:
            out[mother_id].append(father_id)

    return out


def _bfs_neighborhood(
    conn: psycopg.Connection,
    start: str,
    *,
    depth: int,
    max_nodes: int,
) -> list[str]:
    if depth <= 0:
        return [start]

    seen: set[str] = {start}
    frontier = [start]
    for _ in range(depth):
        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []
        for node in frontier:
            for nb in neigh.get(node, []):
                if nb in seen:
                    continue
                seen.add(nb)
                next_frontier.append(nb)
                if len(seen) >= max_nodes:
                    return list(seen)
        frontier = next_frontier
        if not frontier:
            break

    return list(seen)


def _bfs_neighborhood_distances(
    conn: psycopg.Connection,
    start: str,
    *,
    depth: int,
    max_nodes: int,
) -> dict[str, int]:
    """Return node->distance for an undirected person neighborhood BFS."""

    distances: dict[str, int] = {start: 0}

    # Attach spouses for the root immediately (same generation; do not expand via spouse links).
    for sp in _fetch_spouses(conn, [start]).get(start, []):
        if sp in distances:
            continue
        distances[sp] = 0
        if len(distances) >= max_nodes:
            return distances

    if depth <= 0:
        return distances

    frontier = [start]
    for d in range(1, depth + 1):
        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []

        # Expand only through parent/child edges (generation distance).
        for node in frontier:
            for nb in neigh.get(node, []):
                if nb in distances:
                    continue
                distances[nb] = d
                next_frontier.append(nb)
                if len(distances) >= max_nodes:
                    return distances

        # Attach spouses for newly discovered nodes at this generation.
        if next_frontier:
            sp_map = _fetch_spouses(conn, next_frontier)
            for pid in next_frontier:
                for sp in sp_map.get(pid, []):
                    if sp in distances:
                        continue
                    distances[sp] = d
                    if len(distances) >= max_nodes:
                        return distances

        frontier = next_frontier
        if not frontier:
            break

    return distances


def _person_node_row_to_public(r: tuple[Any, ...], *, distance: int | None = None) -> dict[str, Any]:
    # r = (
    #   id, gramps_id, display_name, given_name, surname, gender,
    #   birth_text, death_text, birth_date, death_date,
    #   is_living, is_private, is_living_override
    # )
    (
        pid,
        gid,
        name,
        given_name,
        surname,
        gender,
        birth_text,
        death_text,
        birth_date,
        death_date,
        is_living_flag,
        is_private_flag,
        is_living_override,
    ) = r

    if _is_effectively_private(
        is_private=is_private_flag,
        is_living_override=is_living_override,
        is_living=is_living_flag,
        birth_date=birth_date,
        death_date=death_date,
            birth_text=birth_text,
            death_text=death_text,
    ):
        return {
            "id": pid,
            "gramps_id": gid,
            "type": "person",
            "display_name": "Private",
            "given_name": None,
            "surname": None,
            "gender": None,
            "birth": None,
            "death": None,
            "distance": distance,
        }
    display_name_out, given_name_out, surname_out = _format_public_person_names(
        display_name=name,
        given_name=given_name,
        surname=surname,
    )

    return {
        "id": pid,
        "gramps_id": gid,
        "type": "person",
        "display_name": display_name_out,
        "given_name": given_name_out,
        "surname": surname_out,
        "gender": gender,
        "birth": birth_text,
        "death": death_text,
        "distance": distance,
    }


def _fetch_family_marriage_date_map(
    conn: psycopg.Connection,
    family_ids: list[str],
) -> dict[str, str]:
    """Return a best-effort marriage date/text for each family id.

    Output value is either an ISO date (YYYY-MM-DD) from event.event_date,
    or a raw Gramps date text from event.event_date_text.

    Privacy: only returns dates for non-private events (event.is_private = false).
    Callers should still avoid attaching this to private families.
    """

    if not family_ids:
        return {}

    # Use parameterized ILIKE patterns so psycopg doesn't treat literal '%' as placeholders.
    pat_marriage = "%marriage%"
    pat_wedding = "%wedding%"

    rows = conn.execute(
        """
        SELECT DISTINCT ON (fe.family_id)
               fe.family_id,
               e.event_date,
               e.event_date_text
        FROM family_event fe
        JOIN event e ON e.id = fe.event_id
        WHERE fe.family_id = ANY(%s)
          AND COALESCE(e.is_private, FALSE) = FALSE
          AND (
            e.event_type ILIKE %s
            OR e.event_type ILIKE %s
          )
        ORDER BY fe.family_id,
                 e.event_date NULLS LAST,
                 e.event_date_text NULLS LAST,
                 e.id
        """.strip(),
        (family_ids, pat_marriage, pat_wedding),
    ).fetchall()

    out: dict[str, str] = {}
    for fid, ev_date, ev_text in rows:
        if ev_date is not None:
            out[str(fid)] = ev_date.isoformat()
        elif ev_text:
            out[str(fid)] = str(ev_text)

    # Fallback: some DBs may not have family_event populated.
    # In that case, Gramps often links the marriage event to both spouses as person_event.
    missing = [str(fid) for fid in family_ids if str(fid) not in out]
    if missing:
        # Fallback: infer “marriage” as any shared marriage-type event between the two parents
        # of the family (since this dataset has 0 rows in family_event).
        rows2 = conn.execute(
            """
            WITH fam AS (
              SELECT id, father_id, mother_id
              FROM family
              WHERE id = ANY(%s)
                AND father_id IS NOT NULL
                AND mother_id IS NOT NULL
            )
            SELECT DISTINCT ON (fam.id)
                   fam.id,
                   e.event_date,
                   e.event_date_text
            FROM fam
            JOIN person_event pe_fa ON pe_fa.person_id = fam.father_id
            JOIN person_event pe_mo ON pe_mo.person_id = fam.mother_id
                                 AND pe_mo.event_id = pe_fa.event_id
            JOIN event e ON e.id = pe_fa.event_id
            WHERE COALESCE(e.is_private, FALSE) = FALSE
              AND (
                e.event_type ILIKE %s
                OR e.event_type ILIKE %s
              )
            ORDER BY fam.id,
                     e.event_date NULLS LAST,
                     e.event_date_text NULLS LAST,
                     e.id
            """.strip(),
            (missing, pat_marriage, pat_wedding),
        ).fetchall()

        for fid, ev_date, ev_text in rows2:
            if str(fid) in out:
                continue
            if ev_date is not None:
                out[str(fid)] = ev_date.isoformat()
            elif ev_text:
                out[str(fid)] = str(ev_text)

    return out


def _year_hint_from_fields(
    *,
    birth_date: date | None,
    death_date: date | None,
    birth_text: str | None,
    death_text: str | None,
) -> int | None:
    """Return a best-effort year hint from structured and text dates."""

    if birth_date is not None:
        return birth_date.year
    if death_date is not None:
        return death_date.year
    for s in (birth_text, death_text):
        if not s:
            continue
        m = re.search(r"\b(\d{4})\b", str(s))
        if not m:
            continue
        try:
            y = int(m.group(1))
        except ValueError:
            continue
        if 1 <= y <= date.today().year + 5:
            return y
    return None


@app.post("/graph/places")
def graph_places(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Return distinct public places referenced by events for a set of people.

    This is intended to power the Map "Scope: Current graph" pins without making
    N separate /people/{id}/details calls.

    Privacy:
    - Private/living people are excluded via the same person redaction policy.
    - Private events are excluded (event.is_private = false).
    - Private places are excluded.
    """

    person_ids_raw = payload.get("person_ids") or []
    if not isinstance(person_ids_raw, list):
        raise HTTPException(status_code=400, detail="person_ids must be a list")

    person_ids: list[str] = []
    for x in person_ids_raw:
        s = str(x).strip()
        if not s:
            continue
        person_ids.append(s)

    # Hard guardrails to avoid huge requests.
    person_ids = person_ids[:800]

    limit_raw = payload.get("limit")
    try:
        limit = int(limit_raw) if limit_raw is not None else 5000
    except Exception:
        limit = 5000
    limit = max(1, min(50_000, limit))

    if not person_ids:
        return {"results": [], "total": 0}

    with db_conn() as conn:
        # Apply privacy/redaction policy to the input people ids first.
        cores = _people_core_many(conn, person_ids)
        public_person_ids: list[str] = []
        for pid, p in cores.items():
            # _people_core_many already redacts: private people have display_name="Private".
            if p.get("display_name") == "Private":
                continue
            if bool(p.get("is_private")):
                continue
            public_person_ids.append(str(pid))

        if not public_person_ids:
            return {"results": [], "total": 0}

        rows = conn.execute(
            """
            SELECT DISTINCT
              pl.id,
              pl.gramps_id,
              pl.name,
              pl.lat,
              pl.lon
            FROM person_event pe
            JOIN event e ON e.id = pe.event_id
            JOIN place pl ON pl.id = e.place_id
            WHERE pe.person_id = ANY(%s)
              AND e.is_private = FALSE
              AND pl.is_private = FALSE
              AND pl.lat IS NOT NULL
              AND pl.lon IS NOT NULL
            LIMIT %s
            """.strip(),
            (public_person_ids, limit),
        ).fetchall()

        results: list[dict[str, Any]] = []
        for pid, gid, name, lat, lon in rows:
            results.append(
                {
                    "id": str(pid),
                    "gramps_id": str(gid) if gid else None,
                    "name": name,
                    "lat": float(lat) if lat is not None else None,
                    "lon": float(lon) if lon is not None else None,
                }
            )

    return {"results": results, "total": len(results)}


@app.get("/graph/neighborhood")
def graph_neighborhood(
    id: str = Query(min_length=1, max_length=64),
    depth: int = Query(default=2, ge=0, le=12),
    max_nodes: int = Query(default=1000, ge=1, le=5000),
    layout: Literal["family", "direct"] = Query(default="family"),
) -> dict[str, Any]:
    """Return a small subgraph for interactive exploration.

    - layout=family: Gramps-like family hub nodes (family + person nodes)
    - layout=direct: person nodes only with parent/spouse edges
    """

    root_id = _resolve_person_id(id)

    with db_conn() as conn:
        distances = _bfs_neighborhood_distances(conn, root_id, depth=depth, max_nodes=max_nodes)
        person_ids = list(distances.keys())

        person_rows = conn.execute(
            """
            SELECT id, gramps_id, display_name, given_name, surname, gender,
                   birth_text, death_text, birth_date, death_date,
                   is_living, is_private, is_living_override
            FROM person
            WHERE id = ANY(%s)
            """.strip(),
            (person_ids,),
        ).fetchall()

        # Privacy is primarily decided per-person, but for graph exploration we can
        # safely unredact an undated person if they are directly connected
        # (parent/child) to a clearly-historic *already-public* neighbor.
        # This avoids false "Private" cards for medieval/early-modern people whose
        # dates are missing (common in imported trees).
        historic_year_cutoff = date.today().year - _HISTORIC_YEAR_CUTOFF_YEARS_AGO

        base_private: dict[str, bool] = {}
        year_hint_by_pid: dict[str, int | None] = {}
        row_by_pid: dict[str, tuple[Any, ...]] = {}

        for r_any in person_rows:
          r = tuple(r_any)
          (
              pid,
              gid,
              name,
              given_name,
              surname,
              gender,
              birth_text,
              death_text,
              birth_date,
              death_date,
              is_living_flag,
              is_private_flag,
              is_living_override,
          ) = r

          row_by_pid[str(pid)] = r
          year_hint_by_pid[str(pid)] = _year_hint_from_fields(
              birth_date=birth_date,
              death_date=death_date,
              birth_text=birth_text,
              death_text=death_text,
          )
          base_private[str(pid)] = _is_effectively_private(
              is_private=is_private_flag,
              is_living_override=is_living_override,
              is_living=is_living_flag,
              birth_date=birth_date,
              death_date=death_date,
              birth_text=birth_text,
              death_text=death_text,
          )

        # Build parent/child adjacency among the in-view people.
        # We include both person_parent (direct) and family/family_child (hub-based)
        # relations, because some imports may have incomplete person_parent rows.
        neighbor_pids: dict[str, set[str]] = {str(pid): set() for pid in row_by_pid.keys()}

        def _add_neighbor(a: str | None, b: str | None) -> None:
            if not a or not b:
                return
            if a not in neighbor_pids or b not in neighbor_pids:
                return
            neighbor_pids[a].add(b)
            neighbor_pids[b].add(a)

        # 1) Direct parent links
        pc_rows = conn.execute(
            """
            SELECT parent_id, child_id
            FROM person_parent
            WHERE parent_id = ANY(%s) AND child_id = ANY(%s)
            """.strip(),
            (person_ids, person_ids),
        ).fetchall()
        for parent_id, child_id in pc_rows:
            _add_neighbor(str(parent_id), str(child_id))

        # 2) Family-based links (parents/children through family hubs)
        fam_rows_priv = conn.execute(
            """
            SELECT DISTINCT f.id, f.father_id, f.mother_id
            FROM family f
            LEFT JOIN family_child fc ON fc.family_id = f.id
            WHERE f.father_id = ANY(%s)
               OR f.mother_id = ANY(%s)
               OR fc.child_id = ANY(%s)
            """.strip(),
            (person_ids, person_ids, person_ids),
        ).fetchall()

        family_ids_in_view: list[str] = []
        fam_parents: dict[str, list[str]] = {}
        for fid, father_id, mother_id in fam_rows_priv:
            fid_s = str(fid)
            family_ids_in_view.append(fid_s)
            ps: list[str] = []
            if father_id:
                ps.append(str(father_id))
            if mother_id:
                ps.append(str(mother_id))
            fam_parents[fid_s] = ps

        if family_ids_in_view:
            fc_rows_priv = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = ANY(%s)
                """.strip(),
                (family_ids_in_view,),
            ).fetchall()
            for family_id, child_id in fc_rows_priv:
                fid_s = str(family_id)
                cid_s = str(child_id)
                for pid_s in fam_parents.get(fid_s, []):
                    _add_neighbor(pid_s, cid_s)

        # Determine which nodes are public after base policy.
        # Also cache explicit privacy/living flags for inference guards.
        explicit_private: dict[str, bool] = {}
        explicit_living: dict[str, bool] = {}

        for pid, r in row_by_pid.items():
            (
                _pid,
                _gid,
                _name,
                _given_name,
                _surname,
                _gender,
                _birth_text,
                _death_text,
                _birth_date,
                _death_date,
                is_living_flag,
                is_private_flag,
                is_living_override,
            ) = r
            explicit_private[pid] = bool(is_private_flag)
            explicit_living[pid] = bool(is_living_override is True or is_living_flag is True)

        # Multi-source BFS from clearly-historic public anchors to infer "not living"
        # for nearby undated nodes.
        anchors: list[str] = []
        for pid, is_priv in base_private.items():
            if is_priv:
                continue
            y = year_hint_by_pid.get(pid)
            if y is not None and y <= historic_year_cutoff:
                anchors.append(pid)

        # Bound inference so we don't accidentally unredact too far.
        max_infer_hops = 3
        dist_to_historic: dict[str, int] = {}
        if anchors:
            q: list[str] = []
            for a in anchors:
                dist_to_historic[a] = 0
                q.append(a)

            qi = 0
            while qi < len(q):
                cur = q[qi]
                qi += 1
                dcur = dist_to_historic[cur]
                if dcur >= max_infer_hops:
                    continue
                for nb in neighbor_pids.get(cur, set()):
                    if nb in dist_to_historic:
                        continue
                    dist_to_historic[nb] = dcur + 1
                    q.append(nb)

        final_private: dict[str, bool] = dict(base_private)

        for pid, is_priv in base_private.items():
            if not is_priv:
                continue

            # Never override explicitly private or explicitly living.
            if explicit_private.get(pid, False) or explicit_living.get(pid, False):
                continue

            # Only attempt inference when this person has no usable year hints.
            if year_hint_by_pid.get(pid) is not None:
                continue

            d = dist_to_historic.get(pid)
            if d is not None and d <= max_infer_hops:
                final_private[pid] = False

        nodes: list[dict[str, Any]] = []
        for pid, r in row_by_pid.items():
            dist = distances.get(pid)
            if final_private.get(pid, True):
                (
                    _pid,
                    gid,
                    _name,
                    _given_name,
                    _surname,
                    _gender,
                    _birth_text,
                    _death_text,
                    _birth_date,
                    _death_date,
                    _is_living_flag,
                    _is_private_flag,
                    _is_living_override,
                ) = r
                nodes.append(
                    {
                        "id": pid,
                        "gramps_id": gid,
                        "type": "person",
                        "display_name": "Private",
                        "given_name": None,
                        "surname": None,
                        "gender": None,
                        "birth": None,
                        "death": None,
                        "distance": dist,
                    }
                )
            else:
                nodes.append(_person_node_row_to_public(r, distance=dist))

        node_ids = {n["id"] for n in nodes}

        edges: list[dict[str, Any]] = []

        if layout == "family":
            fam_rows = conn.execute(
                """
                SELECT DISTINCT f.id, f.gramps_id, f.father_id, f.mother_id, f.is_private
                FROM family f
                LEFT JOIN family_child fc ON fc.family_id = f.id
                WHERE f.father_id = ANY(%s)
                   OR f.mother_id = ANY(%s)
                   OR fc.child_id = ANY(%s)
                """.strip(),
                (person_ids, person_ids, person_ids),
            ).fetchall()

            family_ids: list[str] = []
            for fid, fgid, father_id, mother_id, is_private_flag in fam_rows:
                # Filter out "ghost" families: families with no parents.
                # These can be left behind by Gramps merges and only contain a child link,
                # which creates confusing bare hubs and duplicate parent connections.
                if not father_id and not mother_id:
                    continue
                family_ids.append(fid)
                parents_total = int(bool(father_id)) + int(bool(mother_id))
                nodes.append(
                    {
                        "id": fid,
                        "gramps_id": fgid,
                        "type": "family",
                        "is_private": bool(is_private_flag),
                        "parents_total": parents_total,
                        # Total children recorded for this family.
                        # Used by the UI to show an accurate "expand children" affordance.
                        "children_total": None,
                        # True when this family has children outside the current neighborhood cutoff.
                        "has_more_children": None,
                    }
                )

                if father_id and father_id in node_ids:
                    edges.append(
                        {"from": father_id, "to": fid, "type": "parent", "role": "father"}
                    )
                if mother_id and mother_id in node_ids:
                    edges.append(
                        {"from": mother_id, "to": fid, "type": "parent", "role": "mother"}
                    )

            if family_ids:
                marriage_by_family = _fetch_family_marriage_date_map(conn, family_ids)

                # Total children counts for each family.
                counts = conn.execute(
                    """
                    SELECT family_id, COUNT(*)
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    GROUP BY family_id
                    """.strip(),
                    (family_ids,),
                ).fetchall()
                children_total_by_family = {fid2: int(cnt or 0) for (fid2, cnt) in counts}

                # Child edges that are within the current neighborhood payload.
                child_edge_count_by_family: dict[str, int] = {str(fid2): 0 for fid2 in family_ids}
                fc_rows = conn.execute(
                    """
                    SELECT family_id, child_id
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    """.strip(),
                    (family_ids,),
                ).fetchall()
                for family_id, child_id in fc_rows:
                    if child_id in node_ids:
                        edges.append({"from": family_id, "to": child_id, "type": "child"})
                        child_edge_count_by_family[str(family_id)] = child_edge_count_by_family.get(str(family_id), 0) + 1

                # Update family node metadata in-place.
                for n in nodes:
                    if n.get("type") != "family":
                        continue
                    fid2 = n.get("id")
                    if fid2 not in family_ids:
                        continue
                    total = int(children_total_by_family.get(fid2, 0))
                    present = int(child_edge_count_by_family.get(str(fid2), 0))
                    n["children_total"] = total
                    n["has_more_children"] = bool(total > present)
                    if not bool(n.get("is_private")):
                        mv = marriage_by_family.get(str(fid2))
                        if mv:
                            n["marriage"] = mv

        else:
            # parent edges
            pe_rows = conn.execute(
                """
                SELECT child_id, parent_id
                FROM person_parent
                WHERE child_id = ANY(%s) AND parent_id = ANY(%s)
                """.strip(),
                (person_ids, person_ids),
            ).fetchall()
            for child_id, parent_id in pe_rows:
                edges.append({"from": parent_id, "to": child_id, "type": "parent"})

            # spouse/partner edges derived from families (regardless of marriage event)
            sp_rows = conn.execute(
                """
                SELECT father_id, mother_id
                FROM family
                WHERE father_id IS NOT NULL AND mother_id IS NOT NULL
                  AND father_id = ANY(%s) AND mother_id = ANY(%s)
                """.strip(),
                (person_ids, person_ids),
            ).fetchall()
            for father_id, mother_id in sp_rows:
                edges.append({"from": father_id, "to": mother_id, "type": "partner"})

    return {
        "root": id,
        "layout": layout,
        "depth": depth,
        "max_nodes": max_nodes,
        "nodes": nodes,
        "edges": edges,
    }


@app.get("/graph/family/parents")
def graph_family_parents(
    family_id: str = Query(min_length=1, max_length=64),
    child_id: Optional[str] = Query(default=None, max_length=64),
) -> dict[str, Any]:
    """Fetch just the parent couple for a family hub.

    Intended for UI "expand" actions where the graph already contains the family hub
    (via a child edge) but the parents are outside the current neighborhood cutoff.
    """

    with db_conn() as conn:
        fam = conn.execute(
            """
            SELECT id, gramps_id, father_id, mother_id, is_private
            FROM family
            WHERE id = %s OR gramps_id = %s
            LIMIT 1
            """.strip(),
            (family_id, family_id),
        ).fetchone()

        if not fam:
            raise HTTPException(status_code=404, detail=f"family not found: {family_id}")

        fid, fgid, father_id, mother_id, is_private_flag = tuple(fam)

        # Ghost family: nothing meaningful to expand.
        if not father_id and not mother_id:
            raise HTTPException(status_code=404, detail="family has no parents")

        parent_ids = [pid for pid in (father_id, mother_id) if pid]

        # Determine whether this family has more children than we are returning.
        total_children = conn.execute(
            "SELECT COUNT(*) FROM family_child WHERE family_id = %s",
            (fid,),
        ).fetchone()[0]
        total_children_int = int(total_children or 0)

        nodes: list[dict[str, Any]] = [
            {
                "id": fid,
                "gramps_id": fgid,
                "type": "family",
                "is_private": bool(is_private_flag),
                "parents_total": int(bool(father_id)) + int(bool(mother_id)),
                # If we only attach the single expanded child edge, indicate that more children exist.
                "has_more_children": bool(child_id and total_children_int > 1),
                "children_total": total_children_int,
            }
        ]

        if not bool(is_private_flag):
            mv = _fetch_family_marriage_date_map(conn, [fid]).get(str(fid))
            if mv:
                nodes[0]["marriage"] = mv

        birth_links: list[tuple[str, str]] = []

        if parent_ids:
            rows = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname, gender,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (parent_ids,),
            ).fetchall()
            for r in rows:
                nodes.append(_person_node_row_to_public(tuple(r), distance=None))

            # Also include each parent's own parent-family hub as a *stub* (family + child edge only).
            # This allows the UI to show the same "hidden parents" indicator on newly added parents.
            birth_links = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE child_id = ANY(%s)
                """.strip(),
                (parent_ids,),
            ).fetchall()

            birth_family_ids = sorted({fid for (fid, _cid) in birth_links if fid})
            if birth_family_ids:
                fam2_rows = conn.execute(
                    """
                    SELECT id, gramps_id, father_id, mother_id, is_private
                    FROM family
                    WHERE id = ANY(%s)
                    """.strip(),
                    (birth_family_ids,),
                ).fetchall()

                counts2 = conn.execute(
                    """
                    SELECT family_id, COUNT(*)
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    GROUP BY family_id
                    """.strip(),
                    (birth_family_ids,),
                ).fetchall()
                children_total_by_family2 = {fid3: int(cnt or 0) for (fid3, cnt) in counts2}

                for bf_id, bf_gid, bf_father_id, bf_mother_id, bf_private in fam2_rows:
                    # Filter out ghost families when returning stubs.
                    if not bf_father_id and not bf_mother_id:
                        continue
                    nodes.append(
                        {
                            "id": bf_id,
                            "gramps_id": bf_gid,
                            "type": "family",
                            "is_private": bool(bf_private),
                            "parents_total": int(bool(bf_father_id)) + int(bool(bf_mother_id)),
                            "children_total": int(children_total_by_family2.get(bf_id, 0)),
                            # These are returned as stubs (no parent edges), so any children imply expandable.
                            "has_more_children": bool(children_total_by_family2.get(bf_id, 0) > 0),
                        }
                    )

                # Attach marriage date metadata for non-private stub families.
                public_birth_families = [str(n.get("id")) for n in nodes if n.get("type") == "family" and not bool(n.get("is_private"))]
                marriage_by_family2 = _fetch_family_marriage_date_map(conn, public_birth_families)
                for n in nodes:
                    if n.get("type") != "family" or bool(n.get("is_private")):
                        continue
                    mv2 = marriage_by_family2.get(str(n.get("id")))
                    if mv2:
                        n["marriage"] = mv2

        edges: list[dict[str, Any]] = []
        if father_id:
            edges.append({"from": father_id, "to": fid, "type": "parent", "role": "father"})
        if mother_id:
            edges.append({"from": mother_id, "to": fid, "type": "parent", "role": "mother"})

        # Include the family->child edges for this family as well.
        # This makes the returned subgraph self-contained and avoids stranded nodes
        # when the client performs single-parent-family rewrites.
        # Return only the connecting family->child edge for the currently expanded child.
        # If we return *all* siblings, we must also return their person nodes; otherwise
        # Graphviz will invent unnamed oval nodes (confusing in the UI).
        if child_id:
            fc_rows = conn.execute(
                """
                SELECT family_id, child_id
                FROM family_child
                WHERE family_id = %s AND child_id = %s
                """.strip(),
                (fid, child_id),
            ).fetchall()
            for family_id2, child_id2 in fc_rows:
                if family_id2 and child_id2:
                    edges.append({"from": family_id2, "to": child_id2, "type": "child"})

        # Stub edges for each parent's own birth family (family -> parent).
        for bf_id, child_id in (birth_links or []):
            if bf_id and child_id:
                edges.append({"from": bf_id, "to": child_id, "type": "child"})

    return {
        "family_id": family_id,
        "family": fid,
        "nodes": nodes,
        "edges": edges,
    }


@app.get("/graph/family/children")
def graph_family_children(
    family_id: str = Query(min_length=1, max_length=64),
    include_spouses: bool = True,
) -> dict[str, Any]:
    """Fetch the children for a family hub, optionally including each child's spouse block.

    Used for UI "expand down" actions.
    - Always returns the family node and its family->child edges.
    - Returns child person nodes.
    - If include_spouses: also returns (child as parent) families + spouse nodes + parent edges,
      but does not include grandchildren by default (keeps expansions controlled).
    """

    with db_conn() as conn:
        fam = conn.execute(
            """
            SELECT id, gramps_id, father_id, mother_id, is_private
            FROM family
            WHERE id = %s OR gramps_id = %s
            LIMIT 1
            """.strip(),
            (family_id, family_id),
        ).fetchone()
        if not fam:
            raise HTTPException(status_code=404, detail=f"family not found: {family_id}")

        fid, fgid, father_id, mother_id, is_private_flag = tuple(fam)

        total_children = conn.execute(
            "SELECT COUNT(*) FROM family_child WHERE family_id = %s",
            (fid,),
        ).fetchone()[0]
        total_children_int = int(total_children or 0)

        nodes: list[dict[str, Any]] = [
            {
                "id": fid,
                "gramps_id": fgid,
                "type": "family",
                "is_private": bool(is_private_flag),
                "parents_total": int(bool(father_id)) + int(bool(mother_id)),
                "has_more_children": False,
                "children_total": total_children_int,
            }
        ]

        if not bool(is_private_flag):
            mv = _fetch_family_marriage_date_map(conn, [fid]).get(str(fid))
            if mv:
                nodes[0]["marriage"] = mv

        edges: list[dict[str, Any]] = []
        if father_id:
            edges.append({"from": father_id, "to": fid, "type": "parent", "role": "father"})
        if mother_id:
            edges.append({"from": mother_id, "to": fid, "type": "parent", "role": "mother"})

        fc_rows = conn.execute(
            """
            SELECT child_id
            FROM family_child
            WHERE family_id = %s
            """.strip(),
            (fid,),
        ).fetchall()
        child_ids = [r[0] for r in fc_rows if r and r[0]]

        for cid in child_ids:
            edges.append({"from": fid, "to": cid, "type": "child"})

        if child_ids:
            child_rows = conn.execute(
                """
                SELECT id, gramps_id, display_name, given_name, surname, gender,
                       birth_text, death_text, birth_date, death_date,
                       is_living, is_private, is_living_override
                FROM person
                WHERE id = ANY(%s)
                """.strip(),
                (child_ids,),
            ).fetchall()
            for r in child_rows:
                nodes.append(_person_node_row_to_public(tuple(r), distance=None))

        if include_spouses and child_ids:
            # For each child, include their spouse block as parents of their own families.
            # This adds spouse cards and marriage hubs, but avoids pulling in grandchildren.
            fam_rows = conn.execute(
                """
                SELECT id, gramps_id, father_id, mother_id, is_private
                FROM family
                WHERE father_id IS NOT NULL
                  AND mother_id IS NOT NULL
                  AND (father_id = ANY(%s) OR mother_id = ANY(%s))
                """.strip(),
                (child_ids, child_ids),
            ).fetchall()

            spouse_person_ids: set[str] = set()
            spouse_family_ids: set[str] = set()
            for fid2, fgid2, fa2, mo2, priv2 in fam_rows:
                spouse_family_ids.add(fid2)
                nodes.append(
                    {
                        "id": fid2,
                        "gramps_id": fgid2,
                        "type": "family",
                        "is_private": bool(priv2),
                        "parents_total": int(bool(fa2)) + int(bool(mo2)),
                    }
                )
                if fa2:
                    edges.append({"from": fa2, "to": fid2, "type": "parent", "role": "father"})
                    spouse_person_ids.add(fa2)
                if mo2:
                    edges.append({"from": mo2, "to": fid2, "type": "parent", "role": "mother"})
                    spouse_person_ids.add(mo2)

            # Fetch missing spouse person nodes (includes the child too, harmless; merge will de-dupe).
            if spouse_person_ids:
                spouse_rows = conn.execute(
                    """
                    SELECT id, gramps_id, display_name, given_name, surname, gender,
                           birth_text, death_text, birth_date, death_date,
                           is_living, is_private, is_living_override
                    FROM person
                    WHERE id = ANY(%s)
                    """.strip(),
                    (list(spouse_person_ids),),
                ).fetchall()
                for r in spouse_rows:
                    nodes.append(_person_node_row_to_public(tuple(r), distance=None))

            # Mark spouse-block families as expandable-down if they actually have children.
            if spouse_family_ids:
                counts = conn.execute(
                    """
                    SELECT family_id, COUNT(*)
                    FROM family_child
                    WHERE family_id = ANY(%s)
                    GROUP BY family_id
                    """.strip(),
                    (list(spouse_family_ids),),
                ).fetchall()
                counts_by_family = {fid3: int(cnt or 0) for (fid3, cnt) in counts}
                # Update any matching family nodes we already appended.
                for n in nodes:
                    if n.get("type") != "family":
                        continue
                    fid3 = n.get("id")
                    if fid3 in spouse_family_ids:
                        n["children_total"] = int(counts_by_family.get(fid3, 0))
                        n["has_more_children"] = bool(counts_by_family.get(fid3, 0) > 0)

            # Attach marriage date metadata for non-private families in this payload.
            public_family_ids = [str(n.get("id")) for n in nodes if n.get("type") == "family" and not bool(n.get("is_private"))]
            marriage_by_family3 = _fetch_family_marriage_date_map(conn, public_family_ids)
            for n in nodes:
                if n.get("type") != "family" or bool(n.get("is_private")):
                    continue
                mv3 = marriage_by_family3.get(str(n.get("id")))
                if mv3:
                    n["marriage"] = mv3

    return {
        "family_id": family_id,
        "family": fid,
        "nodes": nodes,
        "edges": edges,
    }


def _bfs_path(
    conn: psycopg.Connection,
    start: str,
    goal: str,
    *,
    max_hops: int,
    max_nodes: int,
) -> list[str]:
    if start == goal:
        return [start]

    parents: dict[str, str | None] = {start: None}
    depth: dict[str, int] = {start: 0}
    frontier = [start]

    visited_nodes = 1
    while frontier:
        if visited_nodes > max_nodes:
            raise HTTPException(status_code=400, detail="path search exceeded max_nodes")

        # Stop expanding beyond max_hops.
        if max(depth[n] for n in frontier) >= max_hops:
            break

        neigh = _fetch_neighbors(conn, frontier)
        next_frontier: list[str] = []

        for node in frontier:
            node_depth = depth[node]
            if node_depth >= max_hops:
                continue

            for nb in neigh.get(node, []):
                if nb in parents:
                    continue
                parents[nb] = node
                depth[nb] = node_depth + 1
                visited_nodes += 1

                if nb == goal:
                    # reconstruct
                    path = [goal]
                    cur = node
                    while cur is not None:
                        path.append(cur)
                        cur = parents[cur]
                    path.reverse()
                    return path

                next_frontier.append(nb)

        frontier = next_frontier

    return []


@app.get("/relationship/path")
def relationship_path(
    from_id: str = Query(min_length=1, max_length=64),
    to_id: str = Query(min_length=1, max_length=64),
    max_hops: int = Query(default=12, ge=1, le=50),
) -> dict[str, Any]:
    resolved_from = _resolve_person_id(from_id)
    resolved_to = _resolve_person_id(to_id)

    with db_conn() as conn:
        path_ids = _bfs_path(conn, resolved_from, resolved_to, max_hops=max_hops, max_nodes=100_000)
        if not path_ids:
            return {"from": from_id, "to": to_id, "path": []}

        rows = conn.execute(
            """
            SELECT id, gramps_id, display_name,
                   birth_date, death_date, is_living, is_private, is_living_override
            FROM person
            WHERE id = ANY(%s)
            """.strip(),
            (path_ids,),
        ).fetchall()
        by_id = {
            r[0]: {
                "id": r[0],
                "gramps_id": r[1],
                "display_name": (
                    "Private"
                    if _is_effectively_private(
                        is_private=r[6],
                        is_living_override=r[7],
                        is_living=r[5],
                        birth_date=r[3],
                        death_date=r[4],
                    )
                    else _smart_title_case_name(r[2])
                ),
            }
            for r in rows
        }

    return {
        "from": from_id,
        "to": to_id,
        "path": [by_id.get(pid, {"id": pid, "display_name": None}) for pid in path_ids],
        "hops": max(0, len(path_ids) - 1),
    }


@app.get("/places/{place_id}")
def get_place(place_id: str) -> dict[str, Any]:
    # Placeholder.
    return {
        "id": place_id,
        "name": f"Place {place_id}",
        "lat": None,
        "lon": None,
    }


def is_living(birth: date | None, death: date | None, living_cutoff_years: int = _PRIVACY_AGE_CUTOFF_YEARS) -> bool:
    """Conservative living heuristic for public views.

    - If death is known: not living.
    - If birth is unknown: treat as living (privacy-first).
    - If birth within cutoff: living.

    This should be *configurable* and overrideable per person.
    """

    if death is not None:
        return False
    if birth is None:
        return True

    today = date.today()
    age_years = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
    return age_years < living_cutoff_years
