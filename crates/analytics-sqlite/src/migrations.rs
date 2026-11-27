use analytics_domain::error::AnalyticsError;
use rusqlite::Connection;

const MIGRATION_0001: &str =
    include_str!("../../../apps/web/src/platform/db/migrations/sql/0001_init.sql");
const MIGRATION_0002: &str =
    include_str!("../../../apps/web/src/platform/db/migrations/sql/0002_local_domain_entities.sql");
const MIGRATION_0003: &str =
    include_str!("../../../apps/web/src/platform/db/migrations/sql/0003_transaction_templates.sql");
const MIGRATION_0004: &str =
    include_str!("../../../apps/web/src/platform/db/migrations/sql/0004_receipts.sql");
const MIGRATION_0005: &str =
    include_str!("../../../apps/web/src/platform/db/migrations/sql/0005_analytics_extensions.sql");

const MIGRATIONS: &[(i64, &str)] = &[
    (1, MIGRATION_0001),
    (2, MIGRATION_0002),
    (3, MIGRATION_0003),
    (4, MIGRATION_0004),
    (5, MIGRATION_0005),
];

/// Runs idempotent schema migrations `0001`–`0005` using SQLite `PRAGMA user_version`,
/// matching KaneGrowth's browser migration sequence.
pub fn run_migrations(conn: &Connection) -> Result<(), AnalyticsError> {
    let current_version: i64 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(|e| AnalyticsError::Storage(e.to_string()))?;

    for &(version, sql) in MIGRATIONS {
        if version > current_version {
            conn.execute_batch(sql).map_err(|e| {
                AnalyticsError::Storage(format!("migration v{version} failed: {e}"))
            })?;
            conn.execute_batch(&format!("PRAGMA user_version = {version};"))
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
        }
    }
    Ok(())
}
