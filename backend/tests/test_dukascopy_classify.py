"""Unit tests for day classification and 429 handling (no live network)."""
from __future__ import annotations

import asyncio
from datetime import date
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.providers import dukascopy as dk
from app.data import save_day, load_day_meta, day_is_verified, verified_days_in_range, DATA_DIR
import tempfile
import os
from pathlib import Path


def test_zero_based_month_in_url():
    """June 2026 must request month 05 in Dukascopy path."""
    # We inspect URL construction by calling ticks with a mock client that captures URL.
    captured = {}

    async def run():
        client = AsyncMock()
        resp = MagicMock()
        resp.status_code = 404
        resp.headers = {}
        client.get = AsyncMock(return_value=resp)

        await dk.ticks("US30", date(2026, 6, 11), 0, client)
        url = client.get.call_args[0][0]
        captured["url"] = url
        assert "/2026/05/11/" in url, url
        assert "USA30IDXUSD" in url

    asyncio.get_event_loop().run_until_complete(run())


def test_429_retries_then_failed():
    async def run():
        client = AsyncMock()
        resp = MagicMock()
        resp.status_code = 429
        resp.headers = {}
        client.get = AsyncMock(return_value=resp)

        # Speed up test by patching backoff
        orig = dk._429_BACKOFF
        dk._429_BACKOFF = (0.01, 0.01, 0.01, 0.01)
        try:
            r = await dk.ticks("US30", date(2026, 6, 15), 14, client)
        finally:
            dk._429_BACKOFF = orig

        assert r["classification"] == "FAILED"
        assert r["status"] == 429
        assert r["attempts"] >= 4
        assert client.get.call_count >= 4

    asyncio.get_event_loop().run_until_complete(run())


def test_404_is_expected_empty():
    async def run():
        client = AsyncMock()
        resp = MagicMock()
        resp.status_code = 404
        resp.headers = {}
        client.get = AsyncMock(return_value=resp)
        r = await dk.ticks("US30", date(2026, 6, 13), 0, client)
        assert r["classification"] == "EXPECTED_EMPTY"

    asyncio.get_event_loop().run_until_complete(run())


def test_day_failed_prevents_verified(tmp_path, monkeypatch):
    monkeypatch.setenv("TR_DATA_DIR", str(tmp_path))
    # Re-import data module paths — set DATA_DIR on module
    import app.data as data
    data.DATA_DIR = Path(tmp_path)
    data.DATA_DIR.mkdir(parents=True, exist_ok=True)

    save_day(
        "US30",
        "2026-06-15",
        [],
        {
            "date": "2026-06-15",
            "classification": "FAILED",
            "tick_count": 0,
            "bars1s": 0,
            "successfulHours": 0,
            "failedHours": 24,
            "emptyHours": 0,
        },
    )
    assert day_is_verified("US30", "2026-06-15") is False
    info = verified_days_in_range("US30", "2026-06-15", "2026-06-15")
    assert "2026-06-15" in info["failed"]
    assert info["success"] == []


def test_success_and_empty_verify(tmp_path, monkeypatch):
    import app.data as data
    data.DATA_DIR = Path(tmp_path)
    data.DATA_DIR.mkdir(parents=True, exist_ok=True)

    save_day(
        "US30",
        "2026-06-11",
        [{"time": 1, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 0}],
        {"date": "2026-06-11", "classification": "SUCCESS", "tick_count": 10, "bars1s": 1,
         "successfulHours": 1, "failedHours": 0, "emptyHours": 23},
    )
    save_day(
        "US30",
        "2026-06-13",
        [],
        {"date": "2026-06-13", "classification": "EXPECTED_EMPTY", "tick_count": 0, "bars1s": 0,
         "successfulHours": 0, "failedHours": 0, "emptyHours": 24},
    )
    assert day_is_verified("US30", "2026-06-11") is True
    assert day_is_verified("US30", "2026-06-13") is True
    info = verified_days_in_range("US30", "2026-06-11", "2026-06-13")
    assert "2026-06-11" in info["success"]
    assert "2026-06-13" in info["expected_empty"]
    # 12 missing
    assert "2026-06-12" in info["missing"]


def test_mixed_range_not_complete(tmp_path, monkeypatch):
    import app.data as data
    data.DATA_DIR = Path(tmp_path)
    data.DATA_DIR.mkdir(parents=True, exist_ok=True)

    for day, cls, bars in [
        ("2026-06-11", "SUCCESS", [{"time": 1, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 0}]),
        ("2026-06-12", "SUCCESS", [{"time": 2, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 0}]),
        ("2026-06-13", "EXPECTED_EMPTY", []),
        ("2026-06-14", "EXPECTED_EMPTY", []),
        ("2026-06-15", "FAILED", []),
        ("2026-06-16", "FAILED", []),
    ]:
        save_day("US30", day, bars, {
            "date": day, "classification": cls, "tick_count": len(bars) * 10,
            "bars1s": len(bars), "successfulHours": 1 if cls == "SUCCESS" else 0,
            "failedHours": 24 if cls == "FAILED" else 0, "emptyHours": 24 if cls == "EXPECTED_EMPTY" else 0,
        })

    info = verified_days_in_range("US30", "2026-06-11", "2026-06-16")
    assert set(info["success"]) == {"2026-06-11", "2026-06-12"}
    assert set(info["expected_empty"]) == {"2026-06-13", "2026-06-14"}
    assert set(info["failed"]) == {"2026-06-15", "2026-06-16"}
    complete = len(info["failed"]) == 0 and len(info["missing"]) == 0
    assert complete is False


if __name__ == "__main__":
    # Run without pytest
    test_zero_based_month_in_url()
    print("PASS zero-based month")
    test_429_retries_then_failed()
    print("PASS 429 retries")
    test_404_is_expected_empty()
    print("PASS 404 empty")

    import tempfile
    from pathlib import Path
    import app.data as data

    td = tempfile.mkdtemp()
    data.DATA_DIR = Path(td)
    data.DATA_DIR.mkdir(parents=True, exist_ok=True)

    class NS:
        pass

    # inline the tmp tests
    save_day("US30", "2026-06-15", [], {
        "date": "2026-06-15", "classification": "FAILED", "tick_count": 0, "bars1s": 0,
        "successfulHours": 0, "failedHours": 24, "emptyHours": 0,
    })
    assert day_is_verified("US30", "2026-06-15") is False
    print("PASS failed not verified")

    test_mixed_range_not_complete.__wrapped__ if False else None
    # re-run mixed manually
    for day, cls, bars in [
        ("2026-06-11", "SUCCESS", [{"time": 1, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 0}]),
        ("2026-06-12", "SUCCESS", [{"time": 2, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 0}]),
        ("2026-06-13", "EXPECTED_EMPTY", []),
        ("2026-06-14", "EXPECTED_EMPTY", []),
        ("2026-06-15", "FAILED", []),
        ("2026-06-16", "FAILED", []),
    ]:
        save_day("US30", day, bars, {
            "date": day, "classification": cls, "tick_count": 0, "bars1s": len(bars),
            "successfulHours": 1 if cls == "SUCCESS" else 0,
            "failedHours": 24 if cls == "FAILED" else 0,
            "emptyHours": 24 if cls == "EXPECTED_EMPTY" else 0,
        })
    info = verified_days_in_range("US30", "2026-06-11", "2026-06-16")
    assert set(info["failed"]) == {"2026-06-15", "2026-06-16"}
    assert set(info["expected_empty"]) == {"2026-06-13", "2026-06-14"}
    print("PASS mixed June range")
    print("ALL OK")
