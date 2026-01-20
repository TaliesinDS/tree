from __future__ import annotations

import re

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
    for tok in tokens:
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
