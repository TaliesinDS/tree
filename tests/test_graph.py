from __future__ import annotations

from dataclasses import dataclass

from api.graph import _bfs_neighborhood_distances, _fetch_neighbors, _fetch_spouses


@dataclass
class _FakeResult:
    rows: list[tuple]

    def fetchall(self) -> list[tuple]:
        return list(self.rows)


class _FakeConn:
    def __init__(self, *, person_parent: list[tuple[str, str]], families: list[tuple[str, str]]):
        # person_parent rows are (child_id, parent_id)
        self._person_parent = list(person_parent)
        # families rows are (father_id, mother_id)
        self._families = list(families)

    def execute(self, query: str, params: tuple) -> _FakeResult:
        q = " ".join((query or "").split()).lower()
        if q.startswith("select child_id, parent_id from person_parent"):
            node_ids = set(params[0] or [])
            rows = [(c, p) for (c, p) in self._person_parent if c in node_ids]
            return _FakeResult(rows)

        if q.startswith("select parent_id, child_id from person_parent"):
            node_ids = set(params[0] or [])
            rows = [(p, c) for (c, p) in self._person_parent if p in node_ids]
            return _FakeResult(rows)

        if q.startswith("select father_id, mother_id from family"):
            node_ids = set(params[0] or []) | set(params[1] or [])
            rows = [(fa, mo) for (fa, mo) in self._families if fa in node_ids or mo in node_ids]
            return _FakeResult(rows)

        raise AssertionError(f"Unexpected query: {query}")


def test_fetch_neighbors_adds_parents_and_children() -> None:
    conn = _FakeConn(
        person_parent=[("C1", "P1"), ("C1", "P2"), ("C2", "P1")],
        families=[],
    )

    out = _fetch_neighbors(conn, ["C1", "P1"])
    assert out["C1"] == ["P1", "P2"]
    assert out["P1"] == ["C1", "C2"]


def test_fetch_spouses_returns_partner_pairs() -> None:
    conn = _FakeConn(person_parent=[], families=[("P1", "P2"), ("P3", "P4")])

    out = _fetch_spouses(conn, ["P1", "P2", "P9"])
    assert out["P1"] == ["P2"]
    assert out["P2"] == ["P1"]
    assert out["P9"] == []


def test_bfs_distances_attaches_spouses_same_generation() -> None:
    # Graph:
    #   A --spouse--> S
    #   A ->(parent)-> C
    #   C --spouse--> CS
    conn = _FakeConn(
        person_parent=[("C", "A")],
        families=[("A", "S"), ("C", "CS")],
    )

    d = _bfs_neighborhood_distances(conn, "A", depth=2, max_nodes=100)
    assert d["A"] == 0
    assert d["S"] == 0
    assert d["C"] == 1
    assert d["CS"] == 1
