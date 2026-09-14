"""Small, single-user file store with daily market-data shards.

Market data is stored one UTC day per file so month/year downloads can be
merged safely without creating one enormous JSON document. Settings such as
watchlists and sessions remain small key/value JSON files.

Day metadata (status SUCCESS / EXPECTED_EMPTY / FAILED) is stored alongside
bars so verification does not treat empty placeholders as complete.
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


def meta_key(symbol: str, day: str) -> str:
    return f"bars_1s_meta_{_safe(symbol)}_{day}"


def save_day(symbol: str, day: str, rows: list[dict], meta: dict | None = None) -> None:
    save(day_key(symbol, day), rows)
    if meta is not None:
        save(meta_key(symbol, day), meta)


def load_day(symbol: str, day: str) -> list[dict]:
    return load(day_key(symbol, day), [])


def load_day_meta(symbol: str, day: str) -> dict | None:
    p = keyfile(meta_key(symbol, day))
    if not p.exists():
        # Legacy: if bars exist with content, treat as SUCCESS; empty file as unknown
        rows = load_day(symbol, day)
        if rows and len(rows) > 0:
            return {
                "date": day,
                "classification": "SUCCESS",
                "bars1s": len(rows),
                "tick_count": None,
                "legacy": True,
            }
        if p.exists() is False and keyfile(day_key(symbol, day)).exists():
            return {
                "date": day,
                "classification": "EXPECTED_EMPTY",
                "bars1s": 0,
                "legacy": True,
            }
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def day_is_verified(symbol: str, day: str) -> bool:
    """True if day is SUCCESS with bars>0 or EXPECTED_EMPTY (no need to redownload)."""
    meta = load_day_meta(symbol, day)
    if not meta:
        return False
    cls = meta.get("classification")
    if cls == "SUCCESS":
        rows = load_day(symbol, day)
        return bool(rows and len(rows) > 0)
    if cls == "EXPECTED_EMPTY":
        return True
    return False


def load_1s_range(symbol: str, start: str | None = None, end: str | None = None) -> list[dict]:
    """Load only the requested UTC date range from daily 1s shards."""
    if not start or not end:
        legacy = load(f"{symbol}_1s", [])
        if legacy:
            return legacy
        prefix = f"bars_1s_{_safe(symbol)}_"
        days = sorted(
            p.stem[len(prefix):]
            for p in DATA_DIR.glob(f"{prefix}*.json")
            if p.stem.startswith(prefix) and "_meta_" not in p.name
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
    # Exclude meta files
    return sorted(
        p.stem[len(prefix):]
        for p in DATA_DIR.glob(f"{prefix}*.json")
        if p.stem.startswith(prefix) and not p.stem.startswith(f"bars_1s_meta_")
    )


def verified_days_in_range(symbol: str, start: str, end: str) -> dict:
    """Classify each day in range for status API."""
    from datetime import date, timedelta
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    out = {
        "success": [],
        "expected_empty": [],
        "failed": [],
        "missing": [],
        "day_details": [],
    }
    d = s
    while d <= e:
        iso = d.isoformat()
        meta = load_day_meta(symbol, iso)
        rows = load_day(symbol, iso)
        bars = len(rows) if rows else 0
        if meta:
            cls = meta.get("classification")
            detail = {
                "date": iso,
                "status": cls,
                "ticks": meta.get("tick_count"),
                "bars1s": bars,
                "successfulHours": meta.get("successfulHours"),
                "failedHours": meta.get("failedHours"),
                "emptyHours": meta.get("emptyHours"),
            }
            out["day_details"].append(detail)
            if cls == "SUCCESS" and bars > 0:
                out["success"].append(iso)
            elif cls == "EXPECTED_EMPTY":
                out["expected_empty"].append(iso)
            elif cls == "FAILED":
                out["failed"].append(iso)
            elif bars > 0:
                out["success"].append(iso)
            else:
                out["missing"].append(iso)
        else:
            out["day_details"].append({"date": iso, "status": "MISSING", "bars1s": bars})
            if bars > 0:
                out["success"].append(iso)
            else:
                out["missing"].append(iso)
        d += timedelta(days=1)
    return out
