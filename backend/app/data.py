"""Small, single-user file store with daily market-data shards.

Market data is stored one UTC day per file so month/year downloads can be
merged safely without creating one enormous JSON document. Settings such as
watchlists and sessions remain small key/value JSON files.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re

_DEFAULT = Path(__file__).resolve().parent.parent / "market_data"
DATA_DIR = Path(os.getenv("TR_DATA_DIR", str(_DEFAULT)))
DATA_DIR.mkdir(parents=True, exist_ok=True)

_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe(value: str) -> str:
    return _SAFE.sub("_", value.strip())


def keyfile(key: str) -> Path:
    return DATA_DIR / f"{_safe(key)}.json"


def save(key: str, value) -> None:
    p = keyfile(key)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)


def load(key: str, default=None):
    p = keyfile(key)
    if not p.exists():
        return [] if default is None else default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [] if default is None else default


def day_key(symbol: str, day: str) -> str:
    return f"bars_1s_{_safe(symbol)}_{day}"


def save_day(symbol: str, day: str, rows: list[dict]) -> None:
    save(day_key(symbol, day), rows)


def load_day(symbol: str, day: str) -> list[dict]:
    return load(day_key(symbol, day), [])


def load_1s_range(symbol: str, start: str | None = None, end: str | None = None) -> list[dict]:
    """Load only the requested UTC date range from daily 1s shards."""
    if not start or not end:
        # Backward compatibility with the old single-file cache.
        legacy = load(f"{symbol}_1s", [])
        if legacy:
            return legacy
        # If no range was requested, discover daily shards for the symbol.
        prefix = f"bars_1s_{_safe(symbol)}_"
        days = sorted(
            p.stem[len(prefix):]
            for p in DATA_DIR.glob(f"{prefix}*.json")
            if p.stem.startswith(prefix)
        )
    else:
        from datetime import date, timedelta
        s = date.fromisoformat(start)
        e = date.fromisoformat(end)
        if e < s:
            raise ValueError("end date must not be before start date")
        days = []
        d = s
        while d <= e:
            days.append(d.isoformat())
            d += timedelta(days=1)

    rows: list[dict] = []
    for day in days:
        rows.extend(load_day(symbol, day))
    rows.sort(key=lambda r: r["time"])
    return rows


def cache_days(symbol: str) -> list[str]:
    prefix = f"bars_1s_{_safe(symbol)}_"
    return sorted(
        p.stem[len(prefix):]
        for p in DATA_DIR.glob(f"{prefix}*.json")
        if p.stem.startswith(prefix)
    )
