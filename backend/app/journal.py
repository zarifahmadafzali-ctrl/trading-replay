"""Trade journal: manually-logged closed trades plus derived stats.

Stored the same way as watchlist/sessions — flat JSON via data.py — since
this is a single-user local app. A "trade" here is a completed round-trip
(entry + exit) that the user records themselves; it isn't wired to the
replay/position-drafting flow in Chart.tsx yet, so logging is manual for now.
"""
import uuid
from typing import Optional

from pydantic import BaseModel


class TradeIn(BaseModel):
    symbol: str
    direction: str  # "long" | "short"
    entry_price: float
    exit_price: float
    size: float = 1.0
    stop_price: Optional[float] = None
    take_profit_price: Optional[float] = None
    opened_at: Optional[float] = None
    closed_at: Optional[float] = None
    notes: str = ""


def new_trade_record(t: TradeIn) -> dict:
    record = t.model_dump()
    record["id"] = uuid.uuid4().hex[:12]
    return record


def compute_stats(trades: list[dict]) -> dict:
    """Win rate, R-multiples, and totals across a list of trade records.

    R-multiple = reward / initial risk (distance from entry to stop). Trades
    logged without a stop price still count toward win rate but are excluded
    from the R-based figures, since there's no risk to divide by.
    """
    total = len(trades)
    rs: list[float] = []
    wins = 0
    losses = 0

    for t in trades:
        entry = t["entry_price"]
        exit_ = t["exit_price"]
        stop = t.get("stop_price")
        direction = t["direction"]

        if direction == "long":
            pnl = exit_ - entry
            risk = (entry - stop) if stop else None
        else:
            pnl = entry - exit_
            risk = (stop - entry) if stop else None

        r = (pnl / risk) if risk and risk > 0 else None

        if pnl > 0:
            wins += 1
        elif pnl < 0:
            losses += 1
        if r is not None:
            rs.append(r)

    win_rate = (wins / total * 100) if total else 0.0
    avg_r = sum(rs) / len(rs) if rs else None
    total_r = sum(rs) if rs else None
    best_r = max(rs) if rs else None
    worst_r = min(rs) if rs else None

    return {
        "total": total,
        "wins": wins,
        "losses": losses,
        "win_rate": round(win_rate, 1),
        "avg_r": round(avg_r, 2) if avg_r is not None else None,
        "total_r": round(total_r, 2) if total_r is not None else None,
        "best_r": round(best_r, 2) if best_r is not None else None,
        "worst_r": round(worst_r, 2) if worst_r is not None else None,
    }
