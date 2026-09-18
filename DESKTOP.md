# Trading Replay — Desktop Storage (v3.36.0)

## Application identity

| Field | Value |
|-------|--------|
| Product | Trading Replay |
| Identifier | `com.tradingreplay.afzali` |
| Version | 3.36.0 |

## Storage architecture

| Data | Web | Desktop |
|------|-----|---------|
| Sessions / Journal / shapes / runtime / accounts / Prop | IndexedDB | **SQLite** (`SessionStorageAdapter`) |
| Market 1s bars | IndexedDB `barCache` | **IndexedDB `barCache`** (not migrated in 3.36) |

```
React domain
    ↓
getSessionStorageAdapter()
    ↓
  web → indexedDbSessionAdapter
  desktop → createSqliteSessionAdapter(driver)
              ↓
         Memory (tests) | Tauri invoke (production shell)
```

## SQLite schema

`DESKTOP_SQLITE_SCHEMA_VERSION = 1`

Tables: `meta`, `sessions`, `session_runtime`, `session_shapes`, `journal_trades`, `app_kv`

JSON payloads store the same logical `SessionMeta` / `SessionRuntime` / Journal arrays as the web adapter.

## Database location

Intended: application data directory + `trading-replay.sqlite`  
(via Tauri path API when native rusqlite is linked; placeholder path documented in Rust setup)

## Permissions

Command surface only:

- `sqlite_exec`
- `sqlite_query`

No `filesystem:*`, `shell:*`, or open-ended SQL from UI.

## Migration

IndexedDB is **not** deleted. First desktop SQLite start creates an empty DB. Use App Backup JSON (`BACKUP_FORMAT_VERSION = 1`) to transfer logical data between web and desktop.

## Commands

```bash
npm run dev          # web IndexedDB
npm run build        # PWA
npm run test:sqlite  # memory-driver conformance
npm run tauri:dev    # desktop shell when Rust/CLI available
```
