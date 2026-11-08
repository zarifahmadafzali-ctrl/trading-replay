# C2.0 — Tick-native execution specification

Baseline: Trading Replay main @ dccd959 · app version 3.48.8  
Scope: pure rules for Tick Mode execution. UI wiring is C2.2+.

## 1. Quotes

Each tick provides `bid`, `ask`, `time` (fractional unix seconds), optional `seq`.

- **Mid** is display-only. Never used for Tick fills or SL/TP.
- Process ticks in ascending `(time, seq)` order. Equal timestamps keep source order via `seq`.

## 2. Side-aware prices

| Event | Price |
|-------|--------|
| Buy market entry | Ask |
| Sell market entry | Bid |
| Long SL / TP evaluate & exit | Bid |
| Short SL / TP evaluate & exit | Ask |
| Buy stop trigger | Ask ≥ stop |
| Sell stop trigger | Bid ≤ stop |
| Buy limit fill | Ask ≤ limit → fill `min(limit, ask)` (never worse than limit) |
| Sell limit fill | Bid ≥ limit → fill `max(limit, bid)` |

Stop orders: trigger on the aggressive quote of that side; **fill at the triggering quote** (ask for buys, bid for sells).

Limit orders: fill only when marketable; fill at best available quote **not worse than** the limit (price improvement allowed).

## 3. Position lifecycle on ticks

1. **draft** — ignored by engine.
2. **pending** — wait for entry condition; on fill → **open**, set `entry.time` / `entry.price`.
3. **open** — evaluate SL then TP (SL-first if both hit on the same tick).
4. Closed positions leave the working set; emit `ClosedInfo`.

**Same-tick rule:** A position that **fills** on tick T must **not** evaluate SL/TP on T.

**Market orders** confirmed as `status: "open"` in the UI are already open; engine only runs SL/TP. If a market order is still `pending`, fill on the first tick at Ask (buy/long) or Bid (sell/short).

## 4. Gap-through

On a single tick there is no intra-tick path. If the quote crosses beyond SL/TP:

- Long SL: if `bid <= stop`, exit at **bid** (may be beyond stop).
- Long TP: if `bid >= tp`, exit at **bid**.
- Short SL: if `ask >= stop`, exit at **ask**.
- Short TP: if `ask <= tp`, exit at **ask**.

No commission, swap, or extra slippage models in C2.

## 5. Jump / Previous policy (no reverse execution)

| Action | Behavior |
|--------|----------|
| Previous one tick | Move clock only. **Do not** un-fill or un-close. Open positions remain open; engine pauses further execution until state is consistent (see below). |
| Jump To earlier time | Clock moves; **no** reverse fills. If any position has `entry.time` **after** the new clock, or a close was already journaled for this id, mark session **execution suspended** until reset. |
| Jump To later time | Clock moves forward; from lastProcessed, process ticks in order up to the new time **once** (or only process as Play/Next advances — product may choose “lazy” only-on-step). C2.1 pure engine processes only the ticks it is given. |
| Play after backward seek | Must not re-emit closes for ids already in Journal. Integration holds an idempotency set. |
| Session reload | Restore shapes + journal as stored; lastProcessed should reset from persisted cursor or recompute safely without duplicating journal rows. |

**C2 does not implement reversible execution.** Backward seek never deletes Journal rows.

If open-position state is inconsistent with the new replay time (e.g. entry in the future relative to clock), **pause execution** until the user resets positions or reloads a consistent session.

## 6. Seconds mode

Unchanged: `runPositionBars` + 1s OHLC. Tick rules apply only when the Tick engine is invoked.

## 7. Journal (integration later)

Additive metadata only: `executionMode: "tick"`, fractional times, optional bid/ask audit fields. No schema break.
