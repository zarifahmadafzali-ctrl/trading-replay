"""Dukascopy historical tick provider and true 1-second OHLC builder."""
from __future__ import annotations

import asyncio
import gzip
import lzma
import struct
from datetime import date, datetime, timezone

import httpx

BASE_URL = "https://datafeed.dukascopy.com/datafeed"
RECORD_SIZE = 20

# Dukascopy symbols whose published integer prices use 1/1000 points.
DIV_1000 = {
    "USA30IDXUSD", "USA500IDXUSD", "USATECHIDXUSD", "DEUIDXEUR",
    "XAUUSD", "XAGUSD", "BRENTCMDUSD", "LIGHTCMDUSD",
}

ALIASES = {
    "US30": "USA30IDXUSD", "USA30": "USA30IDXUSD", "DJ30": "USA30IDXUSD", "DJIA": "USA30IDXUSD",
    "GOLD": "XAUUSD", "XAUUSD": "XAUUSD", "BTCUSD": "BTCUSD", "EURUSD": "EURUSD",
}


def normalize_symbol(symbol: str) -> str:
    sym = symbol.replace("/", "").replace(".", "").replace(" ", "").upper()
    return ALIASES.get(sym, sym)


def point_divisor(sym: str) -> float:
    return 1000.0 if sym in DIV_1000 else 100000.0


def decompress(content: bytes) -> bytes:
    if not content:
        return b""
    for decoder in (lzma.decompress, gzip.decompress):
        try:
            return decoder(content)
        except Exception:
            continue
    if len(content) % RECORD_SIZE == 0:
        return content
    raise ValueError("Unsupported or corrupt Dukascopy compression")


def parse_ticks(raw: bytes, hour_start: float, divisor: float) -> list[dict]:
    out: list[dict] = []
    for i in range(0, len(raw) - (RECORD_SIZE - 1), RECORD_SIZE):
        chunk = raw[i:i + RECORD_SIZE]
        try:
            ms, ask_i, bid_i, ask_vol, bid_vol = struct.unpack(">IIIff", chunk)
        except struct.error:
            continue
        ask = ask_i / divisor
        bid = bid_i / divisor
        if ask <= 0 and bid <= 0:
            continue
        out.append({
            "time": hour_start + ms / 1000.0,
            "bid": bid if bid > 0 else ask,
            "ask": ask if ask > 0 else bid,
            "volume": float(ask_vol) + float(bid_vol),
        })
    return out


def ticks_to_seconds(tick_list: list[dict], seconds: int = 1) -> list[dict]:
    buckets: dict[int, list[float]] = {}
    for t in sorted(tick_list, key=lambda x: x["time"]):
        bucket = int(t["time"] // seconds) * seconds
        mid = (t["bid"] + t["ask"]) / 2
        if bucket not in buckets:
            buckets[bucket] = [mid, mid, mid, mid, 0.0]
        else:
            b = buckets[bucket]
            b[1] = max(b[1], mid)
            b[2] = min(b[2], mid)
            b[3] = mid
        buckets[bucket][4] += t.get("volume", 0.0)
    return [
        {"time": k, "open": b[0], "high": b[1], "low": b[2], "close": b[3], "volume": b[4]}
        for k, b in sorted(buckets.items())
    ]


# Bounded 429 backoff schedule (seconds). Prefer Retry-After when present (capped).
_429_BACKOFF = (2.0, 5.0, 10.0, 20.0)
_MAX_RETRY_AFTER = 60.0
# Max attempts for 429 (initial + retries). Other errors use fewer.
_MAX_429_ATTEMPTS = 5
_MAX_OTHER_ATTEMPTS = 3
# Small polite gap between sequential hour requests
_INTER_REQUEST_DELAY = 0.35


async def ticks(
    symbol: str,
    day: date,
    hour: int,
    client: httpx.AsyncClient,
) -> dict:
    """Download one hour of Dukascopy ticks.

    Returns dict with:
      hour, ticks, status (http or 0), classification:
        SUCCESS | EXPECTED_EMPTY | FAILED
      error, attempts
    """
    sym = normalize_symbol(symbol)
    # Dukascopy historical paths use zero-based month (June → 05). Do not "fix".
    url = f"{BASE_URL}/{sym}/{day.year}/{day.month - 1:02d}/{day.day:02d}/{hour:02d}h_ticks.bi5"
    last_error = ""
    last_status = 0
    attempt = 0

    while attempt < _MAX_429_ATTEMPTS:
        attempt += 1
        try:
            resp = await client.get(url)
            last_status = resp.status_code

            # Genuine no-data from Dukascopy
            if resp.status_code in (404, 204):
                return {
                    "hour": hour,
                    "ticks": [],
                    "status": resp.status_code,
                    "classification": "EXPECTED_EMPTY",
                    "error": "no file",
                    "attempts": attempt,
                }

            # Rate limited — backoff and retry (bounded)
            if resp.status_code == 429:
                last_error = "HTTP 429 Too Many Requests"
                if attempt >= _MAX_429_ATTEMPTS:
                    break
                delay = _429_BACKOFF[min(attempt - 1, len(_429_BACKOFF) - 1)]
                ra = resp.headers.get("Retry-After")
                if ra:
                    try:
                        delay = min(_MAX_RETRY_AFTER, max(delay, float(ra)))
                    except ValueError:
                        pass
                await asyncio.sleep(delay)
                continue

            # Other HTTP errors
            if resp.status_code >= 400:
                last_error = f"HTTP {resp.status_code}"
                if attempt >= _MAX_OTHER_ATTEMPTS:
                    break
                await asyncio.sleep(0.8 * attempt)
                continue

            raw = decompress(resp.content)
            hour_start = datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc).timestamp()
            data = parse_ticks(raw, hour_start, point_divisor(sym))
            if data:
                return {
                    "hour": hour,
                    "ticks": data,
                    "status": resp.status_code,
                    "classification": "SUCCESS",
                    "error": "",
                    "attempts": attempt,
                }
            # 200 but zero parseable ticks → treat as expected empty for that hour
            return {
                "hour": hour,
                "ticks": [],
                "status": resp.status_code,
                "classification": "EXPECTED_EMPTY",
                "error": "empty payload",
                "attempts": attempt,
            }
        except Exception as exc:
            last_error = str(exc)
            last_status = 0
            if attempt >= _MAX_OTHER_ATTEMPTS:
                break
            await asyncio.sleep(0.8 * attempt)

    return {
        "hour": hour,
        "ticks": [],
        "status": last_status,
        "classification": "FAILED",
        "error": last_error or f"HTTP {last_status}",
        "attempts": attempt,
    }


async def download_day_hours(
    symbol: str,
    day: date,
    client: httpx.AsyncClient,
    log: list | None = None,
) -> dict:
    """Download all 24 hours for one day sequentially (rate-limit safe).

    Returns day summary with classification SUCCESS | EXPECTED_EMPTY | FAILED,
    ticks list, and hour diagnostics.
    """
    all_ticks: list[dict] = []
    hours: list[dict] = []
    success_h = 0
    empty_h = 0
    failed_h = 0

    for h in range(24):
        if h > 0:
            await asyncio.sleep(_INTER_REQUEST_DELAY)
        r = await ticks(symbol, day, h, client)
        hours.append({
            "hour": h,
            "status": r["status"],
            "classification": r["classification"],
            "ticks": len(r["ticks"]),
            "attempts": r.get("attempts", 1),
            "error": r.get("error") or "",
        })
        if log is not None:
            log.append(
                f"{day.isoformat()} {h:02d}h attempt={r.get('attempts',1)} "
                f"HTTP={r['status']} {r['classification']}"
                + (f" retry_err={r['error']}" if r["classification"] == "FAILED" else "")
                + (f" ticks={len(r['ticks'])}" if r["ticks"] else "")
            )
        if r["classification"] == "SUCCESS":
            success_h += 1
            all_ticks.extend(r["ticks"])
        elif r["classification"] == "EXPECTED_EMPTY":
            empty_h += 1
        else:
            failed_h += 1

    if success_h > 0:
        classification = "SUCCESS"
    elif failed_h > 0:
        # Any failed hour without successful data → day is incomplete
        classification = "FAILED"
    else:
        classification = "EXPECTED_EMPTY"

    return {
        "date": day.isoformat(),
        "classification": classification,
        "ticks": all_ticks,
        "tick_count": len(all_ticks),
        "successfulHours": success_h,
        "emptyHours": empty_h,
        "failedHours": failed_h,
        "hours": hours,
    }
