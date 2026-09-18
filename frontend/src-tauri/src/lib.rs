//! Trading Replay — Tauri shell + real rusqlite (v3.36.1).
//! Frontend only uses typed adapter SQL via sqlite_exec / sqlite_query.

#![cfg_attr(mobile, tauri::mobile_entry_point)]

use rusqlite::{params_from_iter, Connection, ToSql};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub struct DbState {
    pub conn: Mutex<Connection>,
    pub path: PathBuf,
}

fn value_to_sql(v: &Value) -> Box<dyn ToSql> {
    match v {
        Value::Null => Box::new(None::<String>),
        Value::Bool(b) => Box::new(if *b { 1_i64 } else { 0_i64 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(u) = n.as_u64() {
                Box::new(u as i64)
            } else {
                Box::new(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

fn bind_params(params: &[Value]) -> Vec<Box<dyn ToSql>> {
    params.iter().map(value_to_sql).collect()
}

pub fn open_db(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open sqlite: {e}"))?;
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY NOT NULL,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_runtime (
          session_id TEXT PRIMARY KEY NOT NULL,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_shapes (
          session_id TEXT PRIMARY KEY NOT NULL,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS journal_trades (
          session_id TEXT PRIMARY KEY NOT NULL,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| format!("schema: {e}"))?;
    // DESKTOP_SQLITE_SCHEMA_VERSION = 1
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
        rusqlite::params!["desktop_sqlite_schema_version", "1"],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn app_db_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("trading-replay.sqlite");
    }
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.push("trading-replay-data");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("trading-replay.sqlite")
}

/// Allow-list matching frontend sqliteSqlGuard (v3.37.0).
/// Domain UI never constructs SQL; only SessionStorageAdapter fixed shapes.
fn assert_allowed_exec(sql: &str) -> Result<(), String> {
    let sql_trim = sql.trim();
    if sql_trim.is_empty() {
        return Ok(());
    }
    let body = sql_trim.trim_end_matches(';').trim();
    if body.contains(';') {
        return Err("multi-statement exec rejected".into());
    }
    let upper = body.to_uppercase();
    let compact: String = upper.split_whitespace().collect::<Vec<_>>().join(" ");

    if compact.starts_with("SELECT") {
        return Err("use sqlite_query for SELECT".into());
    }
    // Hard rejects
    if compact.contains("DROP ")
        || compact.contains("ATTACH ")
        || compact.contains("DETACH ")
        || compact.starts_with("ALTER ")
        || compact.starts_with("UPDATE ")
        || compact.contains(" PRAGMA ")
            && !compact.starts_with("PRAGMA FOREIGN_KEYS")
    {
        return Err("sqlite_exec statement not allowed".into());
    }

    let ok = compact.starts_with("BEGIN")
        || compact.starts_with("COMMIT")
        || compact.starts_with("ROLLBACK")
        || compact.starts_with("CREATE TABLE IF NOT EXISTS ")
        || compact.starts_with("INSERT OR REPLACE INTO ")
        || compact.starts_with("INSERT OR IGNORE INTO ")
        || compact.starts_with("DELETE FROM ")
        || compact == "PRAGMA FOREIGN_KEYS = ON"
        || compact == "PRAGMA FOREIGN_KEYS=ON";

    if !ok {
        return Err("sqlite_exec statement not on allow-list".into());
    }
    Ok(())
}

fn assert_allowed_query(sql: &str) -> Result<(), String> {
    let body = sql.trim().trim_end_matches(';').trim();
    if body.is_empty() {
        return Err("empty query".into());
    }
    if body.contains(';') {
        return Err("multi-statement query rejected".into());
    }
    let upper = body.to_uppercase();
    if !upper.starts_with("SELECT ") && upper != "SELECT" {
        return Err("sqlite_query only accepts SELECT".into());
    }
    if upper.contains(" INTO ") || upper.contains("ATTACH") || upper.contains("LOAD_EXTENSION") {
        return Err("sqlite_query statement not allowed".into());
    }
    Ok(())
}

#[tauri::command]
fn sqlite_exec(state: tauri::State<'_, DbState>, sql: String, params: Vec<Value>) -> Result<(), String> {
    let sql_trim = sql.trim();
    if sql_trim.is_empty() {
        return Ok(());
    }
    assert_allowed_exec(sql_trim)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let bound = bind_params(&params);
    let refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();
    conn.execute(sql_trim.trim_end_matches(';'), params_from_iter(refs))
        .map_err(|e| format!("sqlite_exec: {e}"))?;
    Ok(())
}

#[tauri::command]
fn sqlite_query(
    state: tauri::State<'_, DbState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let sql_trim = sql.trim().trim_end_matches(';');
    assert_allowed_query(sql_trim)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let bound = bind_params(&params);
    let refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn
        .prepare(sql_trim)
        .map_err(|e| format!("prepare: {e}"))?;
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map(params_from_iter(refs), |row| {
            let mut map = Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let v: Value = match row.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                    Ok(rusqlite::types::ValueRef::Integer(n)) => Value::Number(n.into()),
                    Ok(rusqlite::types::ValueRef::Real(f)) => serde_json::Number::from_f64(f)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                    Ok(rusqlite::types::ValueRef::Text(t)) => {
                        Value::String(String::from_utf8_lossy(t).into_owned())
                    }
                    Ok(rusqlite::types::ValueRef::Blob(_)) => Value::String("<blob>".into()),
                    Err(_) => Value::Null,
                };
                map.insert(name.clone(), v);
            }
            Ok(Value::Object(map))
        })
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app_db_path(app.handle());
            let conn = open_db(&path).map_err(|e| {
                eprintln!("sqlite open failed: {e}");
                e
            })?;
            app.manage(DbState {
                conn: Mutex::new(conn),
                path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sqlite_exec, sqlite_query])
        .run(tauri::generate_context!())
        .expect("error while running Trading Replay");
}
