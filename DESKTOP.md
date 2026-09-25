# Trading Replay — Desktop Storage (v3.36.0)

## Application identity

| Field | Value |
|-------|--------|
| Product | Trading Replay |
| Identifier | `com.tradingreplay.afzali` |
| Version | 3.36.1 |

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


## v3.36.1 — Native rusqlite

Real SQLite via `rusqlite` (bundled) behind:

- `sqlite_exec`
- `sqlite_query`

### Native verification (no GUI)

```bash
# Standalone proof (works on Rust 1.70–1.75):
cd /path/to/verify-crate   # or cargo run --bin sqlite_verify when Tauri deps resolve
```

Persistence checks: create session/runtime/shapes/journal → close → reopen → data remains → transactional delete.

### Tauri full shell

Tauri 2 + current plugins may require **Rust/Cargo ≥ 1.77** (edition2024). This environment used 1.75 — full `tauri:dev` / Windows EXE not completed here.

`DESKTOP_SQLITE_SCHEMA_VERSION = 1` unchanged.

## v3.37.0 — Desktop SQLite storage hardening (no GUI required)

Code-level completion of the SQLite layer without requiring Tauri GUI/GTK/WebKit:

- Shared SQL allow-list (`sqliteSqlGuard.ts` + Rust `assert_allowed_exec` / `assert_allowed_query`)
- Reject DROP / ATTACH / multi-statement / non-SELECT abuse on IPC
- Schema ensure: non-destructive versioning; refuse newer-than-supported schema
- Expanded memory-driver tests: multi-session isolation, zero-session, rollback, market-data table absence
- `DESKTOP_SQLITE_SCHEMA_VERSION` remains **1**
- `BACKUP_FORMAT_VERSION` remains **1**
- Market bars remain IndexedDB-only

### Explicitly NOT verified in this release environment

| Item | Status |
|------|--------|
| Tauri GUI (`tauri:dev`) | BLOCKED — missing gdk-3.0 / webkit2gtk on host |
| Real Tauri → SQLite IPC | NOT RUN |
| Windows EXE | NOT RUN (Linux host) |


## v3.38.0 — Portable data & cross-platform storage

Logical app backup remains **BACKUP_FORMAT_VERSION = 1** and is platform-neutral:

- Export/import accept an optional `SessionStorageAdapter` (IndexedDB or SQLite).
- Same JSON restores sessions, runtime, shapes, journal, accounts/Prop fields on either store.
- Market-data bars remain excluded; market cache is independent of session delete.
- Validation rejects future formatVersion and embedded bars/marketData.
- Tauri GUI / Windows EXE still **NOT RUN** in environments without GTK/WebKit or Windows.


## v3.39.0 — GitHub Actions Windows build

Build a **Windows** installer/EXE on a GitHub-hosted runner. You do **not** need Visual Studio or the Tauri toolchain on your laptop.

### How to run the build

1. Open the GitHub repo: `zarifahmadafzali-ctrl/trading-replay`
2. Go to **Actions** → workflow **Windows Tauri Build**
3. Click **Run workflow** → **Run workflow** (`workflow_dispatch` only; not on every push to `main`)
4. Wait for the job `Build Windows installer` on `windows-latest`

### Where to find artifacts

After a green run:

1. Open the completed workflow run
2. **Artifacts** → download **`trading-replay-windows`**

Typical contents (Tauri 2 + `bundle.targets: all`):

| Path pattern | Type |
|--------------|------|
| `*.exe` under NSIS bundle | NSIS installer (unsigned) |
| `*.msi` under MSI bundle | MSI installer (unsigned), if produced |
| `trading-replay.exe` / product EXE | Raw release binary (unsigned) |

Exact filenames depend on Tauri/NSIS naming (`productName`: **Trading Replay**, identifier `com.tradingreplay.afzali`).

### Unsigned build warning

This workflow does **not** configure code signing certificates or secrets.

- Windows SmartScreen / Defender may warn on first run.
- Treat the artifact as an **unsigned** developer package until you add your own signing step.

### Local requirements (optional)

- **Using GitHub Actions:** no Visual Studio on the developer machine.
- **Local `npm run tauri:build` on Windows:** still needs Rust MSVC + WebView2 + VS Build Tools as per Tauri docs — independent of this CI path.

### What this does not change

- PWA / browser build (`npm run build`) remains available.
- Storage formats, backup, market data, and trading logic are unchanged by this workflow.
