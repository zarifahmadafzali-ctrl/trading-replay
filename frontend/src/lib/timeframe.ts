// Isolated timeframe-aggregation entry point (v3.15.0).
//
// The 1-second → any-timeframe aggregator already lives in `replay.ts` and
// is exercised throughout the replay engine (ReplayView's `visibleBars`,
// the execution engine's `replayBar`, etc.) — `aggregateBars(bars, seconds)`
// is already exactly the signature this module was asked to provide.
//
// Rather than duplicate that logic into a second implementation that could
// silently drift out of sync, this file re-exports it under a dedicated,
// discoverable name/path for the custom-timeframe feature:
//
//   1-second bars
//        ↓
//   aggregateBars(bars, timeframeSeconds)   ← Timeframe Aggregator
//        ↓
//   selected-timeframe candles
//        ↓
//   Chart / Replay display
//
// `timeframeSeconds` is any positive integer — 60 (1m), 180 (3m), 420 (7m),
// 90 (90s), whatever the user picks or types into the custom-timeframe box
// in ReplayView. Nothing here ever mutates the original 1-second source
// data; aggregation is a pure, read-only derivation.
export { aggregateBars, aggregateVisible } from "./replay";
