from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from typing import Any, Iterator

import api.routes.graph as graph_routes


class _FakeState:
    """Minimal stand-in for starlette's request.state."""
    instance_slug = None
    user = {"id": 1, "username": "test", "role": "admin"}


class _FakeRequest:
    """Minimal stand-in for a FastAPI/Starlette Request."""
    state = _FakeState()


@dataclass
class _FakeResult:
    rows: list[tuple[Any, ...]]

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self.rows)


class _FakeConn:
    def __init__(
        self,
        *,
        people_rows: list[tuple[Any, ...]],
        person_parent_rows: list[tuple[str, str]],
        family_rows_priv: list[tuple[str, str | None, str | None]],
        family_rows_full: list[tuple[str, str, str | None, str | None, bool]],
        family_child_rows: list[tuple[str, str]],
    ) -> None:
        self._people_rows = list(people_rows)
        self._person_parent_rows = list(person_parent_rows)
        self._family_rows_priv = list(family_rows_priv)
        self._family_rows_full = list(family_rows_full)
        self._family_child_rows = list(family_child_rows)

    def execute(self, query: str, params: tuple[Any, ...]) -> _FakeResult:
        q = " ".join((query or "").split()).lower()

        if q.startswith("select id, gramps_id, display_name") and "from person" in q:
            return _FakeResult(self._people_rows)

        if q.startswith("select parent_id, child_id from person_parent"):
            return _FakeResult([(p, c) for (c, p) in self._person_parent_rows])

        if q.startswith("select distinct f.id, f.father_id, f.mother_id from family f"):
            return _FakeResult(self._family_rows_priv)

        if q.startswith(
            "select distinct f.id, f.gramps_id, f.father_id, f.mother_id, f.is_private from family f"
        ):
            return _FakeResult(self._family_rows_full)

        if q.startswith("select family_id, count(*) from family_child"):
            # params: (family_ids,)
            family_ids = set(str(x) for x in (params[0] or []))
            counts: dict[str, int] = {}
            for fid, _cid in self._family_child_rows:
                if fid not in family_ids:
                    continue
                counts[fid] = counts.get(fid, 0) + 1
            return _FakeResult([(fid, cnt) for (fid, cnt) in counts.items()])

        if q.startswith("select family_id, child_id from family_child"):
            return _FakeResult(self._family_child_rows)

        raise AssertionError(f"Unexpected query: {query}")


def test_neighborhood_family_layout_includes_child_edges() -> None:
    # Regression: graph_neighborhood computed node_ids before adding family nodes,
    # which filtered out all family->child edges (type='child').
    p1 = "P1"
    p2 = "P2"
    c1 = "C1"
    f1 = "F1"

    people_rows = [
        # r = (id, gramps_id, display_name, given_name, surname, gender,
        #      birth_text, death_text, birth_date, death_date,
        #      is_living, is_private, is_living_override)
        (p1, "I0001", "Root", "Root", "Person", "M", "1800", "1870", date(1800, 1, 1), date(1870, 1, 1), False, False, False),
        (p2, "I0002", "Spouse", "Spouse", "Person", "F", "1802", "1872", date(1802, 1, 1), date(1872, 1, 1), False, False, False),
        (c1, "I0003", "Child", "Child", "Person", "U", "1830", "1900", date(1830, 1, 1), date(1900, 1, 1), False, False, False),
    ]

    conn = _FakeConn(
        people_rows=people_rows,
        person_parent_rows=[],
        family_rows_priv=[(f1, p1, p2)],
        family_rows_full=[(f1, "F0001", p1, p2, False)],
        family_child_rows=[(f1, c1)],
    )

    @contextmanager
    def _fake_db_conn() -> Iterator[_FakeConn]:
        yield conn

    # Keep this test narrowly focused on payload wiring.
    graph_routes._bfs_neighborhood_distances = lambda *_a, **_kw: {p1: 0, p2: 0, c1: 1}
    graph_routes._resolve_person_id = lambda _id, _slug=None: p1
    graph_routes.db_conn = lambda _slug=None: _fake_db_conn()
    graph_routes._fetch_family_marriage_date_map = lambda *_a, **_kw: {}

    payload = graph_routes.graph_neighborhood(request=_FakeRequest(), id="I0063", depth=5, max_nodes=1000, layout="family")

    nodes = payload.get("nodes")
    edges = payload.get("edges")
    assert isinstance(nodes, list)
    assert isinstance(edges, list)

    node_ids = {n.get("id") for n in nodes}
    assert f1 in node_ids
    assert c1 in node_ids

    child_edges = [e for e in edges if e.get("type") == "child"]
    assert {e.get("from") for e in child_edges} == {f1}
    assert {e.get("to") for e in child_edges} == {c1}

    parent_edges = [e for e in edges if e.get("type") == "parent"]
    assert {e.get("to") for e in parent_edges} == {f1}
    assert {e.get("from") for e in parent_edges} == {p1, p2}


def test_neighborhood_edges_reference_existing_nodes() -> None:
    # A lightweight contract test: every edge endpoint should exist in nodes.
    p1 = "P1"
    p2 = "P2"
    c1 = "C1"
    f1 = "F1"

    people_rows = [
        (p1, "I0001", "Root", "Root", "Person", "M", "1800", "1870", date(1800, 1, 1), date(1870, 1, 1), False, False, False),
        (p2, "I0002", "Spouse", "Spouse", "Person", "F", "1802", "1872", date(1802, 1, 1), date(1872, 1, 1), False, False, False),
        (c1, "I0003", "Child", "Child", "Person", "U", "1830", "1900", date(1830, 1, 1), date(1900, 1, 1), False, False, False),
    ]

    conn = _FakeConn(
        people_rows=people_rows,
        person_parent_rows=[],
        family_rows_priv=[(f1, p1, p2)],
        family_rows_full=[(f1, "F0001", p1, p2, False)],
        family_child_rows=[(f1, c1)],
    )

    @contextmanager
    def _fake_db_conn() -> Iterator[_FakeConn]:
        yield conn

    graph_routes._bfs_neighborhood_distances = lambda *_a, **_kw: {p1: 0, p2: 0, c1: 1}
    graph_routes._resolve_person_id = lambda _id, _slug=None: p1
    graph_routes.db_conn = lambda _slug=None: _fake_db_conn()
    graph_routes._fetch_family_marriage_date_map = lambda *_a, **_kw: {}

    payload = graph_routes.graph_neighborhood(request=_FakeRequest(), id="I0063", depth=1, max_nodes=1000, layout="family")
    nodes = payload["nodes"]
    edges = payload["edges"]

    node_ids = {n.get("id") for n in nodes}
    for e in edges:
        assert e.get("from") in node_ids
        assert e.get("to") in node_ids
