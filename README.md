# Trading Replay v3.2

Paper-trading historical replay PWA based on the Grok v3.1 project.

## Core replay design

**Tick data → true 1-second OHLC → any higher timeframe.**

The replay cursor advances through every stored one-second bar. If the chart is set to 5m, 15m, 1H, etc., the visible candle is rebuilt from the 1-second source as replay progresses. This means the price inside a 5-minute candle can change one second at a time instead of jumping directly to the next 5-minute candle.

This is not tick-by-tick playback. The finest replay step is one second, exactly as intended for this version.

## Data storage

Market data is stored as **one UTC day per JSON file**. This avoids one enormous JSON file and lets you sync a month, several months, or a year in smaller batches. Existing dates do not get overwritten by a failed hourly download.

Small app state such as watchlist and sessions remains in ordinary JSON files.

## Sync reliability

Dukascopy hourly downloads now run with limited concurrency and retries. Sync reports:

- successful hourly files
- missing hourly files
- failed hourly files
- total ticks
- total generated 1-second bars
- a short error list when failures occur

A sync is marked successful only when useful source data was actually obtained and no hourly requests failed.

## Important data limitation

1-minute OHLC data cannot reconstruct real movement inside the minute. True second-by-second replay requires tick or 1-second source data. This project builds the 1-second bars directly from Dukascopy tick data when that source is available.

## Running locally

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate       # Windows: venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

For production, set `VITE_API_BASE` to the deployed FastAPI backend URL before building.

## Replay workflow

1. Open **Data Engine**.
2. Choose a symbol and date range.
3. Sync the range from Dukascopy.
4. Open **Replay**.
5. Choose the same symbol and date range.
6. Press **Load 1s Replay**.
7. Select any chart timeframe.
8. Play or use the next-second button.

The chart timeframe changes, but the replay clock stays at one second.

## Safety

The application is a **paper-trading simulator**. It does not place live orders.

## v3.14.1 replay execution fixes

- Position tool renders correctly on aggregated display timeframes even when the true market entry timestamp is inside a 5s/1m/5m candle. Stored Market Entry remains the exact replay price/time.
- SL/TP execution uses the exact 1-second replay source bar, not the displayed timeframe candle.
- If both SL and TP are touched in the same 1-second OHLC bar, SL is selected deterministically because OHLC does not reveal intrasecond ordering.
- Auto-closed replay positions are written immediately to the device Journal and then best-effort synced to the backend.
- Journal now works as a single local-first Journal when the backend is offline; manual entries are also stored locally.
- RSI remains intentionally deferred.

## v3.15.0 custom timeframe replay

- Added `3m` as a first-class preset timeframe alongside the existing 1m/2m/5m/15m/30m/1H/4H/1D.
- Arbitrary custom timeframes (e.g. `90s`, `7m`, `10m`) were already supported via the "Custom" box in the TF dropdown (regex-parsed, persisted to localStorage) — unchanged, just confirmed working.
- Added `frontend/src/lib/timeframe.ts`: a thin, documented re-export of `aggregateBars`/`aggregateVisible` from `replay.ts` under a dedicated, discoverable name for this feature. No aggregation logic was duplicated — `replay.ts` remains the single implementation, avoiding drift between two copies of the same math.
- No changes to the Position Tool, Journal, drawing system, backend, or core replay engine — display timeframe (`bars`) and execution (`replayBar`, the true 1-second bar) were already architecturally separate in v3.14.1 and remain so.

## v3.15.2 replay session persistence

- ReplayView stays mounted across in-app navigation (Journal / Data Engine / etc.).
- Session meta (symbol, range, TF, cursor, tools, dataSource) is stored in `localStorage` via `lib/replaySession.ts`.
- Full 1-second bars are **not** stored in localStorage; they reload from the existing day-sharded device cache / backend.
- Refresh restores the previous session in **PAUSED** mode and never silently replaces loaded data with Demo Data.

## v3.15.2.1 panels + replay step

- Desktop Order/TF/Ind dropdowns no longer clipped by top-bar overflow.
- Confirm closes the Orders panel; adding an indicator closes the Indicators panel.
- Separate **Replay Step** control (1s…1h + custom). Next/Prev/Play advance by step.
- SL/TP still evaluates every intermediate **1-second** bar inside a step jump (`execBars`).
