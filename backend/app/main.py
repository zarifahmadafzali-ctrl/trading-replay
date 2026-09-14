from datetime import date, timedelta
import asyncio

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .aggregation import aggregate
from .data import (
    cache_days,
    day_is_verified,
    load,
    load_1s_range,
    load_day,
    load_day_meta,
    save,
    save_day,
    verified_days_in_range,
)
from .journal import TradeIn, compute_stats, new_trade_record
from .providers.dukascopy import download_day_hours, ticks_to_seconds

app = FastAPI(title="Trading Replay Data Engine", version="3.16.7")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Serialize sync jobs so two clients cannot hammer Dukascopy at once.
_sync_lock = asyncio.Lock()


@app.get("/health")
def health():
    return {"ok": True, "service": "trading-replay-data-engine", "paper_only": True, "version": "3.16.7"}


@app.get("/api/data/status")
def status(symbol: str, start: str, end: str):
    try:
        s = date.fromisoformat(start)
        e = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(400, "Invalid ISO date") from exc
    if e < s:
        raise HTTPException(400, "end must not be before start")

    info = verified_days_in_range(symbol, start, end)
    # Complete only when every day is SUCCESS (with bars) or EXPECTED_EMPTY — never FAILED/MISSING
    complete = (
        len(info["failed"]) == 0
        and len(info["missing"]) == 0
        and (len(info["success"]) + len(info["expected_empty"]) > 0)
    )
    # usable = at least one day with real bars
    usable_bars = sum(
        d.get("bars1s") or 0 for d in info["day_details"] if d.get("status") == "SUCCESS" or (d.get("bars1s") or 0) > 0
    )
    return {
        "symbol": symbol,
        "start": start,
        "end": end,
        "has_1s_cache": complete and usable_bars >= 0,  # complete range classification
        "backend_verified": complete,
        "sync_in_progress": _sync_lock.locked(),
        "usable_bars": usable_bars,
        "success_days": info["success"],
        "expected_empty_days": info["expected_empty"],
        "failed_days": info["failed"],
        "missing_days": info["missing"],
        "cached_days": info["success"] + info["expected_empty"],
        "day_details": info["day_details"],
        "note": "1-second market data is stored as daily UTC shards. complete requires SUCCESS or EXPECTED_EMPTY for every day — never FAILED.",
    }



@app.get("/api/bars/day")
def bars_day(symbol: str = Query(...), day: str = Query(...)):
    """Return one UTC day's true 1-second bars (bounded transfer for IndexedDB warm)."""
    try:
        date.fromisoformat(day)
    except ValueError as exc:
        raise HTTPException(400, "day must be YYYY-MM-DD") from exc
    rows = load_day(symbol, day)
    meta = load_day_meta(symbol, day)
    classification = (meta or {}).get("classification")
    if not rows and classification == "EXPECTED_EMPTY":
        return {
            "symbol": symbol,
            "day": day,
            "source": "1s-ticks",
            "classification": "EXPECTED_EMPTY",
            "bars": [],
            "count": 0,
        }
    if not rows:
        raise HTTPException(404, f"No 1-second data for {symbol} {day}")
    return {
        "symbol": symbol,
        "day": day,
        "source": "1s-ticks",
        "classification": classification or "SUCCESS",
        "bars": rows,
        "count": len(rows),
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
        d0 = date.fromisoformat(start)
        e0 = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(400, "Dates must use YYYY-MM-DD") from exc
    if e0 < d0:
        raise HTTPException(400, "end must not be before start")
    if (e0 - d0).days > 366:
        raise HTTPException(400, "Maximum sync range is 366 days")

    if _sync_lock.locked():
        raise HTTPException(409, "Another sync is already running. Wait for it to finish.")

    async with _sync_lock:
        report = {
            "ok": False,
            "symbol": symbol,
            "start": start,
            "end": end,
            "days": 0,
            "ticks": 0,
            "seconds": 0,
            "files_ok": 0,
            "files_missing": 0,
            "files_failed": 0,
            "errors": [],
            "day_results": [],
            "skipped_verified": [],
            "backend_verified": False,
            "log": [],
        }

        # Sequential day processing; each day downloads hours sequentially (rate-limit safe).
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            d = d0
            while d <= e0:
                iso = d.isoformat()
                report["days"] += 1

                # Skip days already verified SUCCESS (with bars) or EXPECTED_EMPTY
                if day_is_verified(symbol, iso):
                    existing = load_day(symbol, iso)
                    report["skipped_verified"].append(iso)
                    report["day_results"].append({
                        "date": iso,
                        "status": "SKIPPED_VERIFIED",
                        "ticks": None,
                        "bars1s": len(existing) if existing else 0,
                    })
                    report["log"].append(f"{iso} SKIPPED_VERIFIED bars={len(existing) if existing else 0}")
                    if existing:
                        report["seconds"] += len(existing)
                        report["files_ok"] += 1
                    d += timedelta(days=1)
                    continue

                day_log: list[str] = []
                day_res = await download_day_hours(symbol, d, client, log=day_log)
                report["log"].extend(day_log)

                classification = day_res["classification"]
                tick_count = day_res["tick_count"]
                report["ticks"] += tick_count
                report["files_ok"] += day_res["successfulHours"]
                report["files_missing"] += day_res["emptyHours"]
                report["files_failed"] += day_res["failedHours"]

                one_second = ticks_to_seconds(day_res["ticks"], 1) if day_res["ticks"] else []
                report["seconds"] += len(one_second)

                meta = {
                    "date": iso,
                    "classification": classification,
                    "tick_count": tick_count,
                    "bars1s": len(one_second),
                    "successfulHours": day_res["successfulHours"],
                    "emptyHours": day_res["emptyHours"],
                    "failedHours": day_res["failedHours"],
                    "hours": day_res["hours"],
                }

                if classification == "SUCCESS":
                    # Only persist real bars on success
                    save_day(symbol, iso, one_second, meta)
                    report["day_results"].append({
                        "date": iso,
                        "status": "SUCCESS",
                        "ticks": tick_count,
                        "bars1s": len(one_second),
                        "successfulHours": day_res["successfulHours"],
                        "failedHours": day_res["failedHours"],
                    })
                elif classification == "EXPECTED_EMPTY":
                    # Persist empty shard + meta so re-sync can skip weekends/holidays
                    save_day(symbol, iso, [], meta)
                    report["day_results"].append({
                        "date": iso,
                        "status": "EXPECTED_EMPTY",
                        "ticks": 0,
                        "bars1s": 0,
                        "successfulHours": 0,
                        "failedHours": 0,
                    })
                else:
                    # FAILED: do NOT overwrite a previous good shard; store meta as FAILED only
                    # if no existing good data
                    existing = load_day(symbol, iso)
                    if existing and len(existing) > 0:
                        # Keep previous bars, mark day still usable
                        meta["classification"] = "SUCCESS"
                        meta["bars1s"] = len(existing)
                        meta["note"] = "kept previous bars after partial re-download failure"
                        save_day(symbol, iso, existing, meta)
                        report["day_results"].append({
                            "date": iso,
                            "status": "SUCCESS",
                            "ticks": None,
                            "bars1s": len(existing),
                            "note": "kept previous",
                        })
                        report["log"].append(f"{iso} FAILED download but kept previous bars={len(existing)}")
                    else:
                        # No good data — mark FAILED, do not invent empty complete
                        save_day(symbol, iso, [], meta)
                        report["day_results"].append({
                            "date": iso,
                            "status": "FAILED",
                            "ticks": tick_count,
                            "bars1s": 0,
                            "successfulHours": day_res["successfulHours"],
                            "failedHours": day_res["failedHours"],
                        })
                        if len(report["errors"]) < 30:
                            report["errors"].append(
                                f"{iso}: {day_res['failedHours']} hour(s) failed (429/network)"
                            )
                        report["log"].append(
                            f"{iso} FAILED success_h={day_res['successfulHours']} "
                            f"empty_h={day_res['emptyHours']} failed_h={day_res['failedHours']}"
                        )

                d += timedelta(days=1)

        # Final verification against stored meta + bars
        info = verified_days_in_range(symbol, start, end)
        complete = (
            len(info["failed"]) == 0
            and len(info["missing"]) == 0
            and (len(info["success"]) + len(info["expected_empty"]) > 0)
        )
        report["backend_verified"] = complete
        report["success_days"] = info["success"]
        report["expected_empty_days"] = info["expected_empty"]
        report["failed_days"] = info["failed"]
        report["missing_days"] = info["missing"]
        report["ok"] = complete
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
    return {
        "true_1s": True,
        "base_resolution": "True 1-second OHLC built from tick data",
        "derived": ["2s", "5s", "10s", "15s", "30s", "1m", "2m", "3m", "5m", "15m", "1H", "4H", "1D"],
        "warning": "Minute OHLC cannot reconstruct intra-minute tick path.",
    }


# --- Journal / watchlist / sessions (unchanged surface) ---

@app.get("/api/journal")
def journal_list():
    return {"trades": load("journal", [])}


@app.get("/api/journal/stats")
def journal_stats():
    return compute_stats(load("journal", []))


@app.post("/api/journal")
def journal_add(body: TradeIn):
    trades = load("journal", [])
    trades.append(new_trade_record(body))
    save("journal", trades)
    return {"ok": True, "trades": trades}


@app.delete("/api/journal/{trade_id}")
def journal_delete(trade_id: str):
    trades = [t for t in load("journal", []) if t.get("id") != trade_id]
    save("journal", trades)
    return {"ok": True, "trades": trades}


@app.get("/api/watchlist")
def watchlist_get():
    return {"items": load("watchlist", [])}


@app.post("/api/watchlist")
def watchlist_add(item: dict):
    items = load("watchlist", [])
    items.append(item)
    save("watchlist", items)
    return {"ok": True, "items": items}


@app.delete("/api/watchlist/{symbol}")
def watchlist_del(symbol: str):
    items = [i for i in load("watchlist", []) if i.get("symbol") != symbol]
    save("watchlist", items)
    return {"ok": True, "items": items}


@app.get("/api/sessions")
def sessions_get():
    return {"sessions": load("sessions", [])}


@app.post("/api/sessions")
def sessions_save(session: dict):
    sessions = load("sessions", [])
    sessions = [s for s in sessions if s.get("name") != session.get("name")]
    sessions.append(session)
    save("sessions", sessions)
    return {"ok": True, "sessions": sessions}


@app.delete("/api/sessions/{name}")
def sessions_del(name: str):
    sessions = [s for s in load("sessions", []) if s.get("name") != name]
    save("sessions", sessions)
    return {"ok": True, "sessions": sessions}
