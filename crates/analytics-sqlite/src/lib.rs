pub mod ledger_adapter;
pub mod migrations;
pub mod saved_view_adapter;

use analytics_domain::error::AnalyticsError;
use rusqlite::Connection;
use std::path::Path;

pub use ledger_adapter::SqliteAnalyticsAdapter;
pub use migrations::run_migrations;
pub use saved_view_adapter::SqliteSavedViewAdapter;

/// Opens a SQLCipher-encrypted SQLite database at `path` using a 64-hex-char 256-bit raw page key
/// (`PRAGMA key = "x'<key_hex>'"`) and verifies readability immediately.
pub fn open_encrypted_connection(
    path: &Path,
    key_hex: &str,
) -> Result<Connection, AnalyticsError> {
    let conn = Connection::open(path).map_err(|e| AnalyticsError::Storage(e.to_string()))?;
    conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
        .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .map_err(|e| AnalyticsError::Storage(format!("SQLCipher key verification failed: {e}")))?;
    Ok(conn)
}
