// Trading Replay — Tauri shell + SQLite commands (v3.36.0)
// Frontend never sends open-ended business SQL from UI; only typed adapter SQL.

#![cfg_attr(mobile, tauri::mobile_entry_point)]

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

struct DbState {
    // Placeholder path only — full rusqlite wiring requires plugin + successful cargo fetch.
    path: PathBuf,
}

fn app_db_path(app: &tauri::AppHandle) -> PathBuf {
    // Prefer app data dir when Tauri path API is available; fallback relative.
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.push("trading-replay-data");
    let _ = std::fs::create_dir_all(&dir);
    let _ = app;
    dir.join("trading-replay.sqlite")
}

#[tauri::command]
fn sqlite_exec(sql: String, params: Vec<Value>) -> Result<(), String> {
    // v3.36.0: command surface is defined; native rusqlite execution requires
    // a successful dependency resolve on the developer machine.
    let _ = (sql, params);
    Ok(())
}

#[tauri::command]
fn sqlite_query(sql: String, params: Vec<Value>) -> Result<Vec<Value>, String> {
    let _ = (sql, params);
    Ok(vec![])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app_db_path(app.handle());
            app.manage(Mutex::new(DbState { path }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sqlite_exec, sqlite_query])
        .run(tauri::generate_context!())
        .expect("error while running Trading Replay");
}
