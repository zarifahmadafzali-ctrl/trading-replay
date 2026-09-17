# Storage architecture (v3.21.0)

## Layers

```
UI / Domain logic
       ↓
Storage Adapter (storageAdapter.ts)   ← platform boundary
       ↓
Web: sessionStore.ts (IndexedDB)
Future Desktop: NOT implemented (Tauri + SQLite)
```

Market-data path is separate:

```
Data Engine / Replay Load 1s
       ↓
barCache.ts (IndexedDB, symbol|day)
```

## Canonical owners

| Entity | Owner |
|--------|--------|
| SessionMeta (incl. accounts, Prop lifecycle events) | `SessionStorageAdapter` |
| SessionRuntime | `SessionStorageAdapter` |
| SessionShapes | `SessionStorageAdapter` |
| Journal / SessionTrades | `journal.ts` → adapter `getTrades`/`putTrades` |
| Accounts + Prop lifecycle | Embedded on `SessionMeta.accounts[]` |
| Market 1s bars | `barCache.ts` only |
| Backup package | `backup.ts` (no market bars) |

## localStorage (audit)

| Key / use | Class | Notes |
|-----------|--------|-------|
| Active session id | UI pointer | Lightweight active pointer |
| Replay session meta | Temporary UI | Runtime authoritative in IndexedDB |
| Custom timeframes | UI preference | OK |
| Drawing favorites | UI preference | OK |
| Legacy journal key | Legacy | Only when no session id |
| Journal audit ring | Debug | Non-authoritative |
| Migrate flags | One-shot | OK |

## Rules

- One authoritative store per entity (no competing writers).
- Deleting a session removes meta + runtime + trades + shapes only.
- Global bar cache is never session-owned.
- Zero sessions must not block Data Engine / Load 1s (v3.20.2).
- Journal delete does not reverse account balance (v3.20.3).

## Market data (v3.22.0)

- Canonical day status: MISSING | PARTIAL | COMPLETE | EMPTY | FAILED | LOADING
- Delete day / symbol / all (market data only)
- Concurrent same-day fetch dedup
- Management UI in Data Engine
