use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub type Db = Arc<Mutex<Connection>>;

pub fn open_db(path: &str) -> Result<Db, String> {
    // Ensure parent dir exists
    if let Some(parent) = Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // pragmatic settings
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|e| e.to_string())?;
    crate::migrations::run_migrations(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub fn conn(db: &Db) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap()
}

pub fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .unwrap();
    let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}
