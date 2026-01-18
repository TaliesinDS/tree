from __future__ import annotations

import argparse
import gzip
import json
import re
import tarfile
import io
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Iterator
from xml.etree import ElementTree as ET


def _strip_ns(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


_DATE_RE_ISO = re.compile(r"^(?P<y>\d{4})(?:-(?P<m>\d{2})(?:-(?P<d>\d{2}))?)?$")
_DATE_RE_COMPACT = re.compile(r"^(?P<y>\d{4})(?P<m>\d{2})?(?P<d>\d{2})?$")


def _parse_date_like(val: str | None) -> str | None:
    if not val:
        return None

    val = val.strip()
    m = _DATE_RE_ISO.match(val)
    if m:
        y = m.group("y")
        mm = m.group("m")
        dd = m.group("d")
        if mm and dd:
            return f"{y}-{mm}-{dd}"
        if mm:
            return f"{y}-{mm}"
        return y

    m = _DATE_RE_COMPACT.match(val)
    if m:
        y = m.group("y")
        mm = m.group("m")
        dd = m.group("d")
        if mm and dd:
            return f"{y}-{mm}-{dd}"
        if mm:
            return f"{y}-{mm}"
        return y

    return None


def _format_gramps_date_element(elem: ET.Element) -> str | None:
    """Convert a Gramps XML date element into a compact, human-ish string.

    Key requirement: preserve qualifier semantics (before/after/about + estimated/calculated)
    so downstream UI can display them like Gramps Desktop.

    DTD notes (Gramps XML v1.7.x):
    - <dateval val="..." type=(before|after|about) quality=(estimated|calculated)>
    - <daterange start="..." stop="..." quality=(estimated|calculated)>
    - <datespan start="..." stop="..." quality=(estimated|calculated)>
    - <datestr val="..."> (already a display string)
    """

    tag = _strip_ns(elem.tag)

    if tag == "datestr":
        v = (elem.get("val") or elem.get("value") or "").strip()
        return v or None

    if tag == "dateval" or tag == "date":
        raw = (elem.get("val") or elem.get("value") or "").strip()
        if not raw:
            return None
        base = _parse_date_like(raw) or raw

        # Gramps qualifier fields.
        qual = (elem.get("quality") or "").strip().lower()  # estimated|calculated
        typ = (elem.get("type") or "").strip().lower()      # before|after|about

        parts: list[str] = []
        if qual in {"estimated", "calculated"}:
            parts.append(qual)
        if typ in {"before", "after", "about"}:
            parts.append(typ)
        parts.append(base)

        out = " ".join([p for p in parts if p]).strip()
        return out or None

    if tag in {"daterange", "datespan"}:
        start = (elem.get("start") or "").strip()
        stop = (elem.get("stop") or "").strip()
        if not start or not stop:
            return None

        s0 = _parse_date_like(start) or start
        s1 = _parse_date_like(stop) or stop

        qual = (elem.get("quality") or "").strip().lower()
        prefix = qual if qual in {"estimated", "calculated"} else ""

        core = f"{s0}–{s1}"
        return f"{prefix} {core}".strip() if prefix else core

    return None


def _year_from_date_str(s: str | None) -> int | None:
    if not s:
        return None
    # Dates may be prefixed by qualifiers like "estimated" / "before".
    m = re.search(r"\b(\d{4})\b", s)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _truthy_int(val: str | None) -> bool:
    if val is None:
        return False
    return val.strip() in {"1", "true", "True", "yes", "Y"}


def _extract_surnames_from_name(name_el: Any) -> list[str]:
    """Extract one or more surnames from a Gramps <name> element.

    Gramps can store multiple surnames per name. We want a deterministic
    "display surname" that matches Gramps' primary/ordering behavior as closely
    as possible (e.g. "van Hofland van Velsen").
    """

    candidates: list[tuple[bool, int, str]] = []
    order_fallback = 0

    for nch in name_el.iter():
        ntag = _strip_ns(nch.tag)
        if ntag not in {"surname", "last"}:
            continue

        base = (nch.text or nch.get("surn") or nch.get("surname") or "").strip()
        if not base:
            continue

        prefix = (nch.get("prefix") or "").strip()
        if prefix and base:
            low = base.lower()
            plow = prefix.lower()
            if low == plow or low.startswith(plow + " "):
                full = base
            else:
                full = f"{prefix} {base}".strip()
        else:
            full = base

        is_primary = _truthy_int(nch.get("prim") or nch.get("primary"))

        order_raw = (
            nch.get("order")
            or nch.get("idx")
            or nch.get("index")
            or nch.get("pos")
            or nch.get("sort")
        )
        try:
            order_key = int(str(order_raw)) if order_raw is not None else order_fallback
        except ValueError:
            order_key = order_fallback
        candidates.append((is_primary, order_key, full))
        order_fallback += 1

    if not candidates:
        return []

    # Prefer primary surname(s) first, but preserve relative order.
    candidates_sorted = sorted(candidates, key=lambda t: (not t[0], t[1]))
    out: list[str] = []
    seen: set[str] = set()
    for _is_primary, _i, s in candidates_sorted:
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def read_gramps_xml_bytes(path: Path) -> bytes:
    """Read a Gramps export.

    Supports:
    - plain XML files
    - gzip-compressed XML (`.gramps` is commonly this)
    - zip/tar packages containing a single XML file
    """

    raw = path.read_bytes()

    def _unwrap(payload: bytes, depth: int = 0) -> bytes:
        # Prevent infinite recursion on weird/corrupt files.
        if depth > 6:
            raise ValueError("Too much nesting while unwrapping Gramps package")

        stripped = payload.lstrip()
        if stripped.startswith(b"<"):
            return payload

        # GZip layers are common (.gpkg and nested data.gramps)
        if payload[:2] == b"\x1f\x8b":
            return _unwrap(gzip.decompress(payload), depth + 1)

        # Zip layer
        if payload.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                names = [n for n in zf.namelist() if not n.endswith("/")]
                if not names:
                    raise ValueError("Zip contains no files")

                preferred = [
                    n
                    for n in names
                    if n.lower().endswith((".xml", ".gramps", ".xml.gz", ".gramps.gz", ".data"))
                ]
                candidates = preferred or names
                candidates_sorted = sorted(
                    candidates, key=lambda n: zf.getinfo(n).file_size, reverse=True
                )

                for name in candidates_sorted:
                    try:
                        return _unwrap(zf.read(name), depth + 1)
                    except Exception:
                        continue
                raise ValueError("Zip contains no XML payload")

        # Tar layer (common for .gpkg: gzip'd tar of media + data.gramps)
        try:
            with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as tf:
                members = [m for m in tf.getmembers() if m.isfile()]
                if not members:
                    raise ValueError("Tar contains no files")

                preferred = [
                    m
                    for m in members
                    if m.name.lower().endswith(("data.gramps", ".xml", ".gramps", ".xml.gz", ".gramps.gz"))
                ]
                candidates = preferred or members
                candidates_sorted = sorted(candidates, key=lambda m: m.size, reverse=True)

                for member in candidates_sorted:
                    fh = tf.extractfile(member)
                    if fh is None:
                        continue
                    try:
                        return _unwrap(fh.read(), depth + 1)
                    except Exception:
                        continue
                raise ValueError("Tar contains no XML payload")
        except tarfile.ReadError:
            pass

        raise ValueError("Unrecognized Gramps export format; expected XML/gzip/zip/tar")

    return _unwrap(raw)


@dataclass
class PersonOut:
    id: str
    gramps_id: str | None
    display_name: str | None
    given_name: str | None
    surname: str | None
    gender: str | None
    birth: str | None
    death: str | None
    is_living: bool
    is_private: bool


@dataclass
class _PersonRaw:
    id: str
    gramps_id: str | None
    display_name: str | None
    given_name: str | None
    surname: str | None
    gender: str | None
    birth: str | None
    death: str | None
    is_living: bool
    is_private: bool


def compute_is_living(birth: str | None, death: str | None, cutoff_years: int) -> bool:
    if death:
        return False
    birth_year = _year_from_date_str(birth)
    if birth_year is None:
        return True
    return (date.today().year - birth_year) < cutoff_years


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def export_from_xml(
    xml_bytes: bytes,
    out_dir: Path,
    living_cutoff_years: int,
    redact_living: bool,
    redact_private: bool,
) -> dict[str, Any]:
    """Export a minimal-but-useful dataset from Gramps XML.

    We intentionally prefer robustness over completeness here:
    - Extract enough for: relationship paths, note search, event browsing, place map.
    - Keep stable IDs as Gramps `handle` strings.
    """

    root = ET.fromstring(xml_bytes)

    people_raw: dict[str, _PersonRaw] = {}
    families: dict[str, dict[str, Any]] = {}
    events: dict[str, dict[str, Any]] = {}
    places: dict[str, dict[str, Any]] = {}
    notes: dict[str, dict[str, Any]] = {}

    person_event: list[dict[str, Any]] = []
    person_note: list[dict[str, Any]] = []
    event_note: list[dict[str, Any]] = []
    family_event: list[dict[str, Any]] = []
    parent_edges: set[tuple[str, str]] = set()  # (child, parent)

    # Helper maps we populate while parsing
    person_eventrefs: dict[str, list[tuple[str, str | None]]] = {}
    person_min_event_year: dict[str, int] = {}
    person_max_event_year: dict[str, int] = {}

    # Gramps XML uses collections; do a 2-pass parse.
    # Pass 1: entities that other objects reference (events, places, notes)
    for elem in root.iter():
        tag = _strip_ns(elem.tag)

        if tag == "placeobj":
            handle = elem.get("handle")
            if not handle:
                continue
            title = None
            lat = None
            lon = None

            # Common patterns: <ptitle value="..."/>, <pname value="..."/>, <coord long=".." lat=".."/>
            for ch in elem:
                ctag = _strip_ns(ch.tag)
                if ctag in {"ptitle", "pname"}:
                    title = ch.get("value") or title
                elif ctag in {"coord", "coordinates"}:
                    lat = ch.get("lat") or lat
                    lon = ch.get("long") or ch.get("lon") or lon

            places[handle] = {
                "id": handle,
                "name": title,
                "lat": float(lat) if lat and lat.strip() else None,
                "lon": float(lon) if lon and lon.strip() else None,
                "is_private": _truthy_int(elem.get("priv")) or _truthy_int(elem.get("private")),
            }

        elif tag == "event":
            handle = elem.get("handle")
            if not handle:
                continue

            gramps_id = elem.get("id")
            ev_type = None
            desc = None
            place_hlink = None
            ev_date = None
            is_private = _truthy_int(elem.get("priv")) or _truthy_int(elem.get("private"))

            for ch in elem:
                ctag = _strip_ns(ch.tag)
                if ctag == "type" and ch.text:
                    ev_type = ch.text.strip() or ev_type
                elif ctag == "description" and ch.text:
                    desc = ch.text.strip()
                elif ctag == "place" and ch.get("hlink"):
                    place_hlink = ch.get("hlink")
                elif ctag in {"daterange", "datespan", "dateval", "datestr", "date"}:
                    # Preserve qualifier semantics from Gramps XML.
                    ev_date = _format_gramps_date_element(ch) or ev_date
                elif ctag == "noteref" and ch.get("hlink"):
                    event_note.append({"event_id": handle, "note_id": ch.get("hlink")})

            events[handle] = {
                "id": handle,
                "gramps_id": gramps_id,
                "type": ev_type,
                "description": desc,
                "date": ev_date,
                "place_id": place_hlink,
                "is_private": is_private,
            }

        elif tag == "note":
            handle = elem.get("handle")
            if not handle:
                continue

            # Note text can be nested; collect all text nodes.
            text_parts: list[str] = []
            for ch in elem.iter():
                ctag = _strip_ns(ch.tag)
                if ctag in {"text", "styledtext"}:
                    if ch.text:
                        text_parts.append(ch.text)
            body = "\n".join([t.strip("\n") for t in text_parts if t is not None]).strip() or None

            notes[handle] = {
                "id": handle,
                "body": body,
                "is_private": _truthy_int(elem.get("priv")) or _truthy_int(elem.get("private")),
            }

    # Pass 2: people/families (need event/place/note dicts)
    for elem in root.iter():
        tag = _strip_ns(elem.tag)

        if tag == "family":
            handle = elem.get("handle")
            if not handle:
                continue

            gramps_id = elem.get("id")

            father = None
            mother = None
            children: list[str] = []
            is_private = _truthy_int(elem.get("priv")) or _truthy_int(elem.get("private"))

            for ch in elem:
                ctag = _strip_ns(ch.tag)
                if ctag == "father" and ch.get("hlink"):
                    father = ch.get("hlink")
                elif ctag == "mother" and ch.get("hlink"):
                    mother = ch.get("hlink")
                elif ctag in {"childref", "child"} and ch.get("hlink"):
                    children.append(ch.get("hlink"))
                elif ctag == "eventref" and ch.get("hlink"):
                    family_event.append(
                        {
                            "family_id": handle,
                            "event_id": ch.get("hlink"),
                            "role": ch.get("role"),
                        }
                    )

            families[handle] = {
                "id": handle,
                "gramps_id": gramps_id,
                "father_id": father,
                "mother_id": mother,
                "children": children,
                "is_private": is_private,
            }

            # Parent edges for relationship traversal.
            for child in children:
                if father:
                    parent_edges.add((child, father))
                if mother:
                    parent_edges.add((child, mother))

        elif tag == "person":
            handle = elem.get("handle")
            if not handle:
                continue

            gramps_id = elem.get("id")

            gender = None
            is_private = _truthy_int(elem.get("priv")) or _truthy_int(elem.get("private"))

            given = None
            surname = None
            display_name = None

            # Names + references
            eventrefs_for_person: list[tuple[str, str | None]] = []
            for ch in elem:
                ctag = _strip_ns(ch.tag)
                if ctag == "gender" and ch.text:
                    gender = ch.text.strip() or None
                elif ctag == "name":
                    # Try common patterns: <first>, <surname>, or attrs
                    first = None
                    for nch in ch.iter():
                        ntag = _strip_ns(nch.tag)
                        if ntag in {"first", "given"} and nch.text:
                            first = nch.text

                    surnames = _extract_surnames_from_name(ch)
                    last = " ".join(surnames).strip() if surnames else None
                    if first and not given:
                        given = first.strip()
                    if last and not surname:
                        surname = last.strip()
                elif ctag == "eventref" and ch.get("hlink"):
                    ev_id = ch.get("hlink")
                    role = ch.get("role")
                    eventrefs_for_person.append((ev_id, role))
                    person_event.append({"person_id": handle, "event_id": ev_id, "role": role})

                elif ctag == "noteref" and ch.get("hlink"):
                    person_note.append({"person_id": handle, "note_id": ch.get("hlink")})

            if given or surname:
                display_name = " ".join([p for p in [given, surname] if p]).strip() or None

            # Remember eventrefs for later logic
            person_eventrefs[handle] = eventrefs_for_person

            # birth/death from referenced events:
            # In Gramps XML, eventrefs have roles like "Primary".
            # Birth/death are determined by the referenced event's <type>.
            birth = None
            death = None
            max_event_year: int | None = None
            min_event_year: int | None = None
            for ev_id, role in eventrefs_for_person:
                if not ev_id:
                    continue
                if (role or "").lower() != "primary":
                    # Still consider non-primary events as a weak hint for "not living"
                    # when the newest known event is older than the cutoff.
                    ev = events.get(ev_id)
                    if ev:
                        y = _year_from_date_str(ev.get("date"))
                        if y is not None:
                            if max_event_year is None or y > max_event_year:
                                max_event_year = y
                            if min_event_year is None or y < min_event_year:
                                min_event_year = y
                    continue
                ev = events.get(ev_id)
                if not ev:
                    continue
                ev_type = (ev.get("type") or "").strip().lower()
                if ev_type == "birth" and not birth:
                    birth = ev.get("date")
                elif ev_type == "death" and not death:
                    death = ev.get("date")

                y = _year_from_date_str(ev.get("date"))
                if y is not None:
                    if max_event_year is None or y > max_event_year:
                        max_event_year = y
                    if min_event_year is None or y < min_event_year:
                        min_event_year = y

            is_living = compute_is_living(birth=birth, death=death, cutoff_years=living_cutoff_years)

            # If birth is unknown, the conservative default marks many old ancestors as living.
            # Improve this by using the newest known event year: if the newest event is older
            # than the living cutoff, treat as not living.
            if is_living and not death and max_event_year is not None:
                if (date.today().year - max_event_year) >= living_cutoff_years:
                    is_living = False

            if min_event_year is not None:
                person_min_event_year[handle] = min_event_year
            if max_event_year is not None:
                person_max_event_year[handle] = max_event_year

            people_raw[handle] = _PersonRaw(
                id=handle,
                gramps_id=gramps_id,
                display_name=display_name,
                given_name=given,
                surname=surname,
                gender=gender,
                birth=birth,
                death=death,
                is_living=is_living,
                is_private=is_private,
            )

    # Heuristic: if a person's birth/death are unknown and they have an old-enough child,
    # treat them as not living. This reduces false "Private" on old ancestors who simply
    # lack explicit birth/death events.
    parent_to_children: dict[str, list[str]] = {}
    for child_id, parent_id in parent_edges:
        parent_to_children.setdefault(parent_id, []).append(child_id)

    today_year = date.today().year
    for pid, pr in people_raw.items():
        if not pr.is_living:
            continue
        if pr.death:
            continue
        if _year_from_date_str(pr.birth) is not None:
            continue

        children = parent_to_children.get(pid) or []
        if not children:
            continue

        # Anchor on the *earliest* child evidence year.
        anchor_year: int | None = None
        for cid in children:
            child = people_raw.get(cid)
            if not child:
                continue

            y_birth = _year_from_date_str(child.birth)
            y_ev = person_min_event_year.get(cid)
            y = y_birth if y_birth is not None else y_ev
            if y is None:
                continue

            if anchor_year is None or y < anchor_year:
                anchor_year = y

        if anchor_year is None:
            continue

        # Conservative lower-bound on parent's birth year: parent must be at least 15 years older.
        inferred_parent_birth_year = anchor_year - 15
        if (today_year - inferred_parent_birth_year) >= living_cutoff_years:
            pr.is_living = False

    # Apply redaction at export time (public DB should not contain living/private details)
    people: dict[str, PersonOut] = {}
    for pid, pr in people_raw.items():
        out_given = pr.given_name
        out_surname = pr.surname
        out_display = pr.display_name
        out_birth = pr.birth
        out_death = pr.death

        should_redact = (redact_living and pr.is_living) or (redact_private and pr.is_private)
        if should_redact:
            out_given = None
            out_surname = None
            out_display = "Private"
            out_birth = None
            out_death = None

        people[pid] = PersonOut(
            id=pr.id,
            gramps_id=pr.gramps_id,
            display_name=out_display,
            given_name=out_given,
            surname=out_surname,
            gender=pr.gender,
            birth=out_birth,
            death=out_death,
            is_living=pr.is_living,
            is_private=pr.is_private,
        )

    # Write outputs
    out_dir.mkdir(parents=True, exist_ok=True)

    write_jsonl(out_dir / "people.jsonl", [p.__dict__ for p in people.values()])
    write_jsonl(out_dir / "families.jsonl", families.values())
    write_jsonl(out_dir / "person_parent.jsonl", [{"child_id": c, "parent_id": p} for (c, p) in sorted(parent_edges)])
    write_jsonl(out_dir / "events.jsonl", events.values())
    write_jsonl(out_dir / "places.jsonl", places.values())
    write_jsonl(out_dir / "notes.jsonl", notes.values())
    write_jsonl(out_dir / "person_event.jsonl", person_event)
    write_jsonl(out_dir / "person_note.jsonl", person_note)
    write_jsonl(out_dir / "event_note.jsonl", event_note)
    write_jsonl(out_dir / "family_event.jsonl", family_event)

    summary = {
        "counts": {
            "people": len(people),
            "families": len(families),
            "person_parent": len(parent_edges),
            "events": len(events),
            "places": len(places),
            "notes": len(notes),
            "person_event": len(person_event),
            "person_note": len(person_note),
            "event_note": len(event_note),
            "family_event": len(family_event),
        },
        "redaction": {
            "living_cutoff_years": living_cutoff_years,
            "redact_living": redact_living,
            "redact_private": redact_private,
        },
    }
    (out_dir / "export_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Export a Gramps .gramps/.xml into JSONL files")
    parser.add_argument("--in", dest="in_path", required=True, help="Path to .gramps or .xml export")
    parser.add_argument("--out-dir", required=True, help="Output directory (will be created)")
    parser.add_argument("--living-cutoff-years", type=int, default=90)
    parser.add_argument("--no-redact-living", action="store_true", help="Do not redact living people")
    parser.add_argument("--no-redact-private", action="store_true", help="Do not redact private records")

    args = parser.parse_args()
    in_path = Path(args.in_path).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()

    if not in_path.exists():
        raise SystemExit(f"Input not found: {in_path}")

    xml_bytes = read_gramps_xml_bytes(in_path)

    summary = export_from_xml(
        xml_bytes=xml_bytes,
        out_dir=out_dir,
        living_cutoff_years=args.living_cutoff_years,
        redact_living=not args.no_redact_living,
        redact_private=not args.no_redact_private,
    )

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
