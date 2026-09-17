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

## v3.15.2.2 dropdown visibility/interaction fix

Diagnosis-only pass (v3.15.2.1) found two CSS root causes and one JS interaction issue for the desktop Orders/Indicators/Timeframe dropdowns and the Replay Step menu. Fixed:

- **`.mobile-scroll` was unconditional.** It set `overflow-x: auto; overflow-y: visible` on all screen sizes, not just mobile. Per the CSS spec, one non-`visible` overflow axis forces the other to compute as `auto`, so `overflow-y` was silently clipping — on desktop too — the absolutely-positioned dropdown panels hosted inside `.bar`/`.replay`. Moved this pair into the existing `@media (max-width: 700px)` block, where it belongs.
- **No explicit stacking layer.** `.bar` and `.replay` had no `z-index`, so whether their dropdowns painted above or below the chart depended on incidental DOM order and the chart library's internal stacking. Gave `.bar`/`.replay` `position: relative; z-index: 30`, and gave `.chartbox` `z-index: 1` so its entire subtree (including `.tv-toolbar`'s `z-index: 100`) is isolated into its own bounded stacking context and can never outrank the bars.
- **One shared `.tools-panel` rule for both a top-opening and bottom-opening menu.** Split into `.panel-top` (TF/Orders/Indicators, opens downward under the top bar) and `.panel-bottom` (Step, opens upward above the bottom bar), each with its own mobile `position: fixed` placement so they no longer occupy the same screen region on small screens.
- **Outside-click used `mousedown`.** Switched to `pointerdown`, which unifies mouse/touch/pen into one consistent event and avoids inconsistent synthetic-event ordering some mobile browsers exhibit with newly-rendered elements.
- **Misleading feedback on Custom Add.** Typing a timeframe that's already a default preset (e.g. "15m") silently switched to it but always said "added." Now says "selected" when it already existed and "added" only when it's genuinely new.

No changes to Chart.tsx, the 1-second execution engine, `execBars`, SL/TP logic, position dragging, the Journal, persistence keys, or the Data Engine. Only `frontend/src/style.css` and `frontend/src/views/ReplayView.tsx` were touched.

## v3.15.2.3 drawing select / delete

- H-Line / V-Line: unselected tap selects (no immediate drag); selected line can drag.
- After placing H/V line, tool auto-resets to crosshair.
- With H/V tool still active, tapping an existing line selects it instead of stacking a new one.
- Delete via ×, toolbar trash, or Delete/Backspace once selected; positions unchanged.

## v3.15.2.4 pending-order lifecycle

- Status model: `draft` → `pending` (Confirm for non-market) → `open` (entry filled on 1s OHLC) → SL/TP → Journal.
- Market Confirm still goes straight to `open`.
- Six pending types: Buy/Sell Limit, Buy/Sell Stop, Buy/Sell Stop Limit.
- Stop-Limit uses explicit `stopPrice` + `limitPrice` and a two-stage trigger (stop arms, then limit fills).
- SL/TP and Journal only run for `status === "open"`.
- Legacy non-market shapes stored as `open` are treated as `pending` on load.

## v3.15.2.5 stop-limit trigger drag

- Buy/Sell Stop Limit: Stop/Trigger (`stopPrice`) is independently draggable from Limit/Entry.
- Dragging stop changes only `stopPrice`; dragging limit changes only `limitPrice`/entry.

## v3.16.0 Backtest Sessions + IndexedDB

- Real isolated Backtest Sessions (meta + runtime + shapes + journal in IndexedDB).
- Market 1s bars remain shared in day-sharded barCache (`SYMBOL|YYYY-MM-DD`).
- SessionView creates/opens/deletes sessions; ReplayView restores full workspace on switch/refresh.
- Journal is session-scoped. Order lifecycle from v3.15.2.5 preserved.
- One-time migration from localStorage into a default session.

## v3.16.1 Risk / Lot model

- Per-order Risk % in Orders panel (not fixed at Session level)
- Up to 3 Account Profiles per Session (balance, leverage, currency)
- Instrument specification (contract/tick/point) — calculated lots, no hard-coded 0.37
- finalLot = min(riskLot, marginMaxLot, volumeMax), round DOWN to lot step
- Trade snapshot fields in Journal; Prop Firm config foundation

## v3.16.2 Professional free drawing

- Continuous time/price coordinates (not limited to candle OHLC)
- Ray + Extended Line
- Magnet OFF/WEAK/STRONG
- Drawing undo/redo
- Auto-return to Select after place

## v3.16.3 Reliability and UX hardening

- Data Engine: sync retry/backoff, verify, warm IndexedDB cache
- Mobile TF preset list touch-scrollable
- Drawing Tools menu, Magnet/Undo UI, floating favorites toolbar
- Session Create: type, strategy, multi-account, instrument, prop firm

## v3.16.4 Data Engine rate-limit and verification

- Sequential Dukascopy downloads with 429 exponential backoff
- SUCCESS / EXPECTED_EMPTY / FAILED day classification
- Status never complete on failed hours
- Re-sync skips verified days; retries FAILED only
- Device warm only after usable SUCCESS data

## v3.16.5 Sync transport recovery

- AbortError / client timeout: no second Sync POST; poll /api/data/status
- HTTP 409: no second POST; wait/poll
- Device warm after recovery when backend_verified

## v3.16.6 Recovery polling fix

- Do not stop recovery on stable partial status with trailing MISSING days
- Warm only when backend_verified / range complete
- Optional status.sync_in_progress from lock

## v3.16.7 Incremental IndexedDB cache

- Per-day `/api/bars/day` transfer
- Local cache fills incrementally during recovery (no giant Warm)
- Resume-safe day shards; dual BACKEND vs LOCAL UI

## v3.17.0 Professional Analytics

- Analytics view from closed Journal only
- Equity/drawdown curves, R stats, streaks, time & breakdown tables
- Session/account/symbol/date filters

## v3.17.1

- Analytics starting balance / account filter fix
- Risk % editable (default 2%)
- Orders panel above date-range bar
- Edit accounts on existing sessions
- Live R:R preview + collision-aware labels
- Favorites float-toolbar primary (full tv-toolbar demoted)

## v3.17.2

- Restored legacy icon-based floating Drawing Toolbar (Toolbar.tsx)
- Removed text float-toolbar UI
- Shared Favorites drive menu + icon toolbar

## v3.17.3

- Fix Account Size / Leverage inputs allowing temporary empty string while editing

## v3.17.4 Multi-Account Core

- Up to 4 accounts per session
- Exactly one Active Account (enabled only)
- trade/position accountId stamped at draft/confirm/fill
- Switcher UI in Orders panel

## v3.17.5 Multi-Account Dynamic Risk

- Account-level minLot/maxLot/lotStep
- Realized PnL updates account.balance; initialBalance immutable
- Margin/risk/finalLot centralized; no shared account maxLot

## v3.17.6 Prop Firm Profiles + Phase Engine

- Generic PropProgram / PropPhase / PropRuleSet
- Evaluation helpers only (no auto lifecycle)
- propRuleSnapshot frozen at fill

## v3.17.7 Prop Lifecycle + Input Fix

- Fix Prop numeric inputs (string drafts, no onChange Number coercion)
- accountLifecycle: derive state from events at replay time
- Phase pass/fail, funded, payout cooldown; block orders when failed/cooldown

## v3.17.8 Configurable Prop Payout Schedules

- Modes: on_demand, weekly, biweekly, monthly, interval
- First delay, min payout, profit split, processing, cooldown
- Pure helpers; lifecycle eligibility uses schedule at replay time

## v3.17.9 Overlay / z-index hardening

- Documented stacking layer map
- tools-wrap.is-open elevates open dropdown without global z-index inflation
- risk-panel scroll without position override (preserves mobile fixed panels)
- No transform/isolation on calculator/risk ancestors

## v3.18.0 Live Position Risk / Reward Calculator

- Target vs actual risk (% and $)
- Live lot, margin, TP $ / %, R:R from centralized riskModel
- Chart SL/TP labels show live $ and %
- Updates on Entry/SL/TP drag via shapes → liveRisk memo
- Preserves v3.17.9 overlay hierarchy

## v3.18.1 Prop Lifecycle + Payout UI

- PropAccountStatus: phase progress, lifecycle state, payout eligibility
- REQUEST PAYOUT via existing buildPayoutEvents (replay-time)
- Payout history from lifecycle events
- Session + Replay wiring; no risk calculator changes

## v3.18.2 Prop Metrics Accuracy + Replay Clock

- Real consistency metric (largest win / total wins)
- SessionRuntime.replayTimeUnix from currentBase.time
- Trades filtered by replay clock for Prop status
- Payout request same-timestamp dedupe

## v3.18.2.1 Daily Loss Breach Fix

- Lifecycle evaluation now aggregates ALL same-day trades (not only the last close).
- PHASE_FAILED with DAILY_LOSS_BREACH note; orders blocked after fail.

## v3.18.2.2 Prop Phase Isolation + Funded Baseline

- Deep-cloned independent phase RuleSets
- Draft keys include phaseId
- Phase-scoped trade evaluation (independent baselines)
- Final phase → FUNDED resets working balance to account size
- Legacy session PropFirm card is non-canonical metadata only

## v3.19.0 Professional Automated Trade Journal

- Idempotent JournalTrade on position close (stable tradeId)
- Extended schema: currencyPnL, balanceAfter, prop phase, reward, margin
- Professional Journal UI: filters, sort, desktop table, mobile cards, detail drawer
- Screenshots at close when Chart provides PNG
- Pending orders never journal until filled+closed

## v3.19.1 Multi-Phase Trading Days + Analytics Account Size

- Minimum trading days = unique UTC exit days (not trade count); required for phase pass
- Phase-scoped day counts (Phase 1 days do not count for Phase 2)
- accountId stable across Phase 1 → Phase 2 → FUNDED
- Analytics starting balance prefers Prop phase accountSize; never invents \$10,000

## v3.19.2 Legacy Prop Lifecycle Reconciliation

- Pure reconcilePropLifecycle from Journal + current rules
- Legacy PHASE_PASSED/FUNDED marked superseded (not deleted)
- deriveLifecycleFromEvents ignores superseded events
- Explicit UI: Preview / Apply reconciliation (no auto-rewrite on load)
- accountId unchanged; Journal immutable; balance not auto-rewritten

## v3.19.3 Prop balance & lifecycle consistency

- Working equity = phase/funded **accountSize baseline** + PnL of trades in that window only
- Phase 1 profit does not enter Phase 2 or FUNDED starting balance
- On PHASE_PASSED / FUNDED, balance resets to next baseline
- Reconciliation reports stored vs expected balance; apply only when fully calculable
- Journal remains immutable; accountId unchanged

## v3.19.4 Full Prop lifecycle audit

- Added `test-prop-full-lifecycle.mjs` covering Phase1→2→FUNDED→payout→cooldown, daily/max loss, min days, consistency, legacy reconciliation, multi-account isolation, and backward/forward replay determinism
- No product-logic bugs requiring code changes; audit confirmed v3.19.3 balance/lifecycle model

## v3.20.0 Storage architecture & PWA-safe desktop readiness

- Platform-neutral `SessionStorageAdapter` (PWA = IndexedDB; Desktop adapter **not** implemented)
- Versioned backup export/import (sessions, accounts, journal, drawings, runtime) — **excludes** market-data bars
- Explicit versions: APP / STORAGE_SCHEMA / BACKUP_FORMAT / MARKET_DATA_CACHE
- PWA continues on IndexedDB; no Tauri/Electron/filesystem runtime
- Future path: PWA ↔ Desktop via backup JSON, shared domain models only

## v3.20.1 Journal backup restore fix

- Export uses `loadJournalForSession` (same path as Journal UI)
- Import uses `saveJournalForSession` + verify read-back
- Stamps `sessionId` on every restored trade
- Dispatches session-changed so Journal/Analytics reload
- Regression: export → delete → import → journal + analytics

## v3.20.2 No-session Data Engine readiness

- Deleting the last Session no longer leaves Replay stuck on "Restoring previous session…"
- Market data remains global: Load 1s / Data Engine work with zero Sessions
- sessionReady=true and loading=false when activeSessionId is null

## v3.20.3 Journal UX + Jump To + screenshots

- Desktop Jump To: time edits no longer overwritten by cursor ticks
- Journal: delete trade with confirmation (row only; balance/lifecycle not auto-reversed)
- Close screenshots fit price scale to show ENTRY + SL + TP

## v3.21.0 Storage adapter adoption

- Journal + SessionView persist via `getSessionStorageAdapter()`
- Canonical ownership documented in `frontend/docs/STORAGE.md`
- Market-data remains barCache (global); schema versions unchanged
- No Tauri/Electron/SQLite

## v3.22.0 Market data management

- Day-level status model + safe cache deletion
- Cache-first complete-day skip preserved
- Concurrent day-fetch deduplication
- Data Engine management panel

## v3.23.0 Replay performance & UX

- Playback interval uses refs (less restart thrash)
- Load 1s race guard (stale async discarded)
- Chart incremental candle update during play
- 1s display path skips full aggregation
- Trading/execution semantics unchanged

## v3.24.0 Professional Journal & Analytics hardening

- Analytics filters: side / result / exit reason (shared filtered set)
- Journal CSV export; Analytics CSV of filtered trades
- JOURNAL_CHANGED event keeps Analytics in sync after delete
- Avg win/loss $ KPIs; R expectancy requires real R samples
- No balance/Prop mutation from Analytics

## v3.24.1 Cross-device market data transfer

- CSV + `.trdata` export/import for global barCache
- Import preview + safe merge
- Independent of App Backup and Sessions
- Desktop readiness: shared portable contracts only (no Tauri/EXE)

## v3.25.0 Professional trading workspace

- Workspace strip: session, symbol/range, active account, book counts
- Book panel: open positions, pending cancel, lightweight timeline
- Hotkeys: Space / arrows / F (follow) / Esc (cancel draft)
- No second Journal, Risk, or Order stores — chart shapes remain canonical
