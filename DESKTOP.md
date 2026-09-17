# Trading Replay — Desktop Foundation (v3.32.0)

## Status

| Target | Status |
|--------|--------|
| Browser / PWA | **Supported** (authoritative product) |
| Windows EXE (Tauri) | **Foundation only** — not a shippable desktop release |
| SQLite storage | **NOT IMPLEMENTED** |
| Auto-updater / GitHub Releases | **NOT IMPLEMENTED** |

## Platform boundary

```
React UI + domain (Replay, Orders, Journal, Analytics, Prop)
        ↓
  platform.ts          → "web" | "desktop"
  SessionStorageAdapter → getSessionStorageAdapter()
  PlatformFileService   → getPlatformFileService()
        ↓
  Web today: IndexedDB + browser download/file input
  Desktop future: same interfaces → Tauri plugins / SQLite
```

Do **not** scatter `window.__TAURI__` checks in trading code.

## Data ownership (unchanged)

| Dataset | Owner |
|---------|--------|
| Market 1s bars | `barCache` (IndexedDB day cache) — global, not session-owned |
| Sessions | `SessionStorageAdapter` → sessionStore |
| Journal | `journal.ts` → adapter trades |
| Accounts / Prop lifecycle | `SessionMeta.accounts[]` |
| Drawings | session shapes via adapter |
| Analytics | **derived** from Journal (read-only) |
| Preferences | localStorage where already used |

## Cross-device transfer

PWA and desktop will **not** share one physical database.

Use:

1. **App backup JSON** (`BACKUP_FORMAT_VERSION = 1`) — sessions, journal, accounts, shapes
2. **Market data export** (`MARKET_DATA_EXPORT_FORMAT_VERSION = 1`) — CSV / `.trdata`

## Development

```bash
cd frontend
npm install
npm run dev          # browser — does NOT require Tauri
npm run build        # PWA production build
npm run test:platform
```

Tauri (optional, separate):

```bash
# Requires Rust + Tauri CLI on the developer machine
npm run tauri:dev    # placeholder until CLI is installed
npm run tauri:build  # Windows EXE NOT produced in CI by default
```

Scaffold lives under `frontend/src-tauri/` for future packaging. The Vite app root remains `frontend/`.

## Future desktop migration contract

```
WEB                         DESKTOP (future)
React                       React (same)
  → SessionStorageAdapter     → SessionStorageAdapter
  → IndexedDB                 → Tauri storage adapter
                              → SQLite / filesystem
```

Business layer above the adapter stays platform-neutral.

## Non-goals (v3.32.0)

- No Electron
- No cloud sync / auth / server database
- No second Journal or market-data store
- No trading-behavior changes
- No incompatible storage/backup format bumps
