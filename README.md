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
