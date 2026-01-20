from __future__ import annotations

from datetime import date

import pytest


@pytest.fixture()
def fixed_today() -> date:
    # Keep tests deterministic.
    return date(2026, 1, 20)
