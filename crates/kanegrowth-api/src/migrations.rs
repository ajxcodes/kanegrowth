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
const MIGRATION_0006: &str = include_str!("../migrations/0006_server_auth_sync.sql");
const MIGRATION_0007: &str =
    include_str!("../../../apps/web/src/platform/db/migrations/sql/0007_envelope_assignments.sql");

const MIGRATIONS: &[(i64, &str)] = &[
    (1, MIGRATION_0001),
    (2, MIGRATION_0002),
    (3, MIGRATION_0003),
    (4, MIGRATION_0004),
    (5, MIGRATION_0005),
    (6, MIGRATION_0006),
    (7, MIGRATION_0007),
];

pub fn run_migrations(conn: &Connection) -> Result<(), String> {
    let current_version: i64 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    for &(version, sql) in MIGRATIONS {
        if version > current_version {
            conn.execute_batch(sql)
                .map_err(|e| format!("migration v{version} failed: {e}"))?;
            conn.execute_batch(&format!("PRAGMA user_version = {version};"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
