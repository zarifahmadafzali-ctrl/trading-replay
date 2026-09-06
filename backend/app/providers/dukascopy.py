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


async def ticks(symbol: str, day: date, hour: int, client: httpx.AsyncClient, retries: int = 2) -> dict:
    sym = normalize_symbol(symbol)
    url = f"{BASE_URL}/{sym}/{day.year}/{day.month - 1:02d}/{day.day:02d}/{hour:02d}h_ticks.bi5"
    last_error = ""
    for attempt in range(retries + 1):
        try:
            resp = await client.get(url)
            if resp.status_code in (404, 204):
                return {"hour": hour, "ticks": [], "status": resp.status_code, "error": "no file"}
            resp.raise_for_status()
            raw = decompress(resp.content)
            hour_start = datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc).timestamp()
            data = parse_ticks(raw, hour_start, point_divisor(sym))
            return {"hour": hour, "ticks": data, "status": resp.status_code, "error": ""}
        except Exception as exc:
            last_error = str(exc)
            if attempt < retries:
                await asyncio.sleep(0.6 * (attempt + 1))
    return {"hour": hour, "ticks": [], "status": 0, "error": last_error}


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
