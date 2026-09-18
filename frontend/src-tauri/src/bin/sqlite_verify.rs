//! Native SQLite persistence verification without Tauri UI (v3.36.1).
//! Exercises the same schema and CRUD contract as the TS adapter.

use rusqlite::{params, Connection};
use std::path::PathBuf;

fn open(path: &PathBuf) -> Connection {
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let conn = Connection::open(path).expect("open");
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_runtime (session_id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_shapes (session_id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS journal_trades (session_id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        ",
    )
    .expect("schema");
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
        params!["desktop_sqlite_schema_version", "1"],
    )
    .ok();
    conn
}

fn main() {
    let path = std::env::temp_dir().join("trading-replay-sqlite-verify.sqlite");
    let _ = std::fs::remove_file(&path);

    // --- session 1 write ---
    {
        let conn = open(&path);
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?1, ?2, ?3)",
            params!["s1", r#"{"id":"s1","name":"US30","accounts":[{"accountId":"a1"}]}"#, 1],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO session_runtime (session_id, json, updated_at) VALUES (?1, ?2, ?3)",
            params!["s1", r#"{"sessionId":"s1","cursor":42}"#, 1],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO session_shapes (session_id, json, updated_at) VALUES (?1, ?2, ?3)",
            params!["s1", r#"[{"id":"h1"}]"#, 1],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO journal_trades (session_id, json, updated_at) VALUES (?1, ?2, ?3)",
            params!["s1", r#"[{"tradeId":"t1"}]"#, 1],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO app_kv (key, value) VALUES (?1, ?2)",
            params!["active_session_id", "s1"],
        )
        .unwrap();
        // transactional delete of unrelated id should not remove s1
        conn.execute("BEGIN", []).unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params!["missing"]).unwrap();
        conn.execute("COMMIT", []).unwrap();
    }

    // --- reopen (restart simulation) ---
    {
        let conn = open(&path);
        let name: String = conn
            .query_row("SELECT json FROM sessions WHERE id = ?1", params!["s1"], |r| r.get(0))
            .expect("session after restart");
        assert!(name.contains("US30"), "session json lost");
        let cursor: String = conn
            .query_row(
                "SELECT json FROM session_runtime WHERE session_id = ?1",
                params!["s1"],
                |r| r.get(0),
            )
            .expect("runtime");
        assert!(cursor.contains("42"), "runtime lost");
        let shapes: String = conn
            .query_row(
                "SELECT json FROM session_shapes WHERE session_id = ?1",
                params!["s1"],
                |r| r.get(0),
            )
            .expect("shapes");
        assert!(shapes.contains("h1"), "shapes lost");
        let trades: String = conn
            .query_row(
                "SELECT json FROM journal_trades WHERE session_id = ?1",
                params!["s1"],
                |r| r.get(0),
            )
            .expect("trades");
        assert!(trades.contains("t1"), "journal lost");
        let active: String = conn
            .query_row(
                "SELECT value FROM app_kv WHERE key = ?1",
                params!["active_session_id"],
                |r| r.get(0),
            )
            .expect("active");
        assert_eq!(active, "s1");
        let ver: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params!["desktop_sqlite_schema_version"],
                |r| r.get(0),
            )
            .expect("schema ver");
        assert_eq!(ver, "1");

        // transactional full delete
        conn.execute("BEGIN", []).unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params!["s1"]).unwrap();
        conn.execute("DELETE FROM session_runtime WHERE session_id = ?1", params!["s1"]).unwrap();
        conn.execute("DELETE FROM session_shapes WHERE session_id = ?1", params!["s1"]).unwrap();
        conn.execute("DELETE FROM journal_trades WHERE session_id = ?1", params!["s1"]).unwrap();
        conn.execute("COMMIT", []).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions WHERE id = ?1", params!["s1"], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "delete failed");
    }

    let _ = std::fs::remove_file(&path);
    println!("PASS native rusqlite persistence + restart + transactional delete");
}
