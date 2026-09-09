from datetime import date, timedelta
import asyncio

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .aggregation import aggregate
from .data import cache_days, load, load_1s_range, save, save_day
from .journal import TradeIn, compute_stats, new_trade_record
from .providers.dukascopy import ticks, ticks_to_seconds

app = FastAPI(title="Trading Replay Data Engine", version="3.2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
def health():
    return {"ok": True, "service": "trading-replay-data-engine", "paper_only": True, "version": "3.2"}

@app.get("/api/data/status")
def status(symbol: str, start: str, end: str):
    try:
        s = date.fromisoformat(start); e = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(400, "Invalid ISO date") from exc
    if e < s:
        raise HTTPException(400, "end must not be before start")
    requested = []
    d = s
    while d <= e:
        requested.append(d.isoformat()); d += timedelta(days=1)
    cached = set(cache_days(symbol))
    present = [x for x in requested if x in cached]
    return {
        "symbol": symbol, "start": start, "end": end,
        "has_1s_cache": len(present) == len(requested),
        "cached_days": present, "missing_days": [x for x in requested if x not in cached],
        "note": "1-second market data is stored as daily UTC shards.",
    }

@app.get("/api/bars")
def bars(symbol: str = "EURUSD", seconds: int = 60, start: str | None = None, end: str | None = None):
    if seconds <= 0:
        raise HTTPException(400, "seconds must be positive")
    rows = load_1s_range(symbol, start, end)
    if rows:
        return {"symbol": symbol, "source": "1s-ticks", "seconds": seconds, "bars": aggregate(rows, seconds)}
    if seconds >= 60 and not start and not end:
        legacy = load(f"{symbol}_60s", [])
        if legacy:
            return {"symbol": symbol, "source": "legacy-1m", "seconds": seconds, "bars": aggregate(legacy, seconds)}
    return {"symbol": symbol, "source": "unavailable", "seconds": seconds, "bars": []}

@app.post("/api/dukascopy/sync")
async def sync(symbol: str = Query(...), start: str = Query(...), end: str = Query(...)):
    try:
        d = date.fromisoformat(start); e = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(400, "Dates must use YYYY-MM-DD") from exc
    if e < d:
        raise HTTPException(400, "end must not be before start")
    if (e - d).days > 366:
        raise HTTPException(400, "Maximum sync range is 366 days")

    report = {"ok": True, "symbol": symbol, "start": start, "end": end, "days": 0, "ticks": 0,
              "seconds": 0, "files_ok": 0, "files_missing": 0, "files_failed": 0, "errors": []}

    limits = asyncio.Semaphore(6)
    async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
        while d <= e:
            day = d
            results = []
            async def one(h: int):
                async with limits:
                    return await ticks(symbol, day, h, client)
            results = await asyncio.gather(*(one(h) for h in range(24)))
            all_ticks = []
            for r in results:
                all_ticks.extend(r["ticks"])
                if r["ticks"]:
                    report["files_ok"] += 1
                elif r["status"] in (404, 204):
                    report["files_missing"] += 1
                else:
                    report["files_failed"] += 1
                    if r["error"] and len(report["errors"]) < 20:
                        report["errors"].append(f"{day.isoformat()} {r['hour']:02d}h: {r['error']}")

            one_second = ticks_to_seconds(all_ticks, 1)
            save_day(symbol, day.isoformat(), one_second)
            report["days"] += 1
            report["ticks"] += len(all_ticks)
            report["seconds"] += len(one_second)
            d += timedelta(days=1)

    report["ok"] = report["files_failed"] == 0 and report["files_ok"] > 0
    return report

@app.post("/api/data/aggregate")
def make_timeframe(symbol: str, seconds: int, start: str | None = None, end: str | None = None):
    one_second = load_1s_range(symbol, start, end)
    if not one_second:
        raise HTTPException(404, "No 1-second source data for this range.")
    rows = aggregate(one_second, seconds)
    return {"ok": True, "symbol": symbol, "seconds": seconds, "rows": len(rows), "source": "1s-ticks"}

@app.get("/api/data/capability")
def capability():
    return {"true_1s": True, "base_resolution": "True 1-second OHLC built from tick data",
            "derived": ["1s", "2s", "5s", "10s", "15s", "30s", "1m", "2m", "5m", "15m", "1H", "4H", "1D"],
            "warning": "1m OHLC cannot reconstruct true within-minute movement."}

class WatchlistItem(BaseModel):
    symbol: str
    note: str = ""

@app.get("/api/watchlist")
def get_watchlist(): return {"items": load("watchlist", [])}

@app.post("/api/watchlist")
def add_watchlist_item(item: WatchlistItem):
    items = load("watchlist", [])
    if not any(i["symbol"] == item.symbol for i in items): items.append(item.model_dump()); save("watchlist", items)
    return {"ok": True, "items": items}

@app.delete("/api/watchlist/{symbol}")
def remove_watchlist_item(symbol: str):
    items = [i for i in load("watchlist", []) if i["symbol"] != symbol]; save("watchlist", items); return {"ok": True, "items": items}

class SessionPayload(BaseModel):
    name: str
    symbol: str
    timeframe_seconds: int
    cursor: int
    speed: float = 1.0
    notes: str = ""

@app.get("/api/sessions")
def list_sessions(): return {"sessions": load("sessions", [])}

@app.post("/api/sessions")
def save_session(payload: SessionPayload):
    sessions = [s for s in load("sessions", []) if s["name"] != payload.name]
    sessions.append(payload.model_dump()); save("sessions", sessions); return {"ok": True, "sessions": sessions}

@app.delete("/api/sessions/{name}")
def delete_session(name: str):
    sessions = [s for s in load("sessions", []) if s["name"] != name]; save("sessions", sessions); return {"ok": True, "sessions": sessions}

@app.get("/api/journal")
def list_trades():
    return {"trades": load("journal", [])}

@app.post("/api/journal")
def log_trade(trade: TradeIn):
    trades = load("journal", [])
    trades.append(new_trade_record(trade))
    save("journal", trades)
    return {"ok": True, "trades": trades}

@app.delete("/api/journal/{trade_id}")
def remove_trade(trade_id: str):
    trades = [t for t in load("journal", []) if t["id"] != trade_id]
    save("journal", trades)
    return {"ok": True, "trades": trades}

@app.get("/api/journal/stats")
def journal_stats():
    return compute_stats(load("journal", []))
