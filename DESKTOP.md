# Trading Replay — Desktop (Tauri)

## Application identity (stable)

| Field | Value |
|-------|--------|
| Product name | Trading Replay |
| Identifier | `com.tradingreplay.afzali` |
| Version | 3.33.0 |

Do not change the identifier after v3.33.0 unless required for store policies.

## Current architecture

```
PWA / Browser:
  React → platform.ts ("web") → SessionStorageAdapter → IndexedDB
  PlatformFileService → Blob download + file input

Desktop (Tauri):
  Same React frontend
  platform.ts ("desktop") when Tauri globals present
  SessionStorageAdapter → still IndexedDB (SQLite NOT implemented)
  PlatformFileService → web fallback (native dialogs NOT wired)
```

## Commands

| Command | Purpose | Requires Tauri CLI |
|---------|---------|-------------------|
| `npm run dev` | Browser Vite | No |
| `npm run build` | PWA production | No |
| `npm run tauri:dev` | Desktop window + Vite | Yes + Rust |
| `npm run tauri:build` | Native bundle | Yes + Rust |

Install CLI (already in package.json as optional script driver):

```bash
cd frontend
npm install
# Rust 1.77+ recommended for Tauri 2
npm run tauri:dev
npm run tauri:build
```

## Permissions (v3.33.0)

Capability `default`:

- `core:default` only
- No filesystem, shell, or arbitrary network grants

Native file dialogs and SQLite are future work and must request explicit capabilities.

## Storage contracts (unchanged)

- `STORAGE_SCHEMA_VERSION = 1`
- `BACKUP_FORMAT_VERSION = 1`
- `MARKET_DATA_EXPORT_FORMAT_VERSION = 1`

PWA and desktop do **not** share one physical database. Transfer via backup JSON + market-data export.

## Future (not in 3.33.0)

- SQLite / filesystem adapter implementing `SessionStorageAdapter`
- Native file dialogs via Tauri plugins
- Auto-updater / GitHub Releases
- Code signing

## Validation notes

See release report for what was actually executed in CI/sandbox (Windows EXE may be NOT RUN on Linux hosts).
