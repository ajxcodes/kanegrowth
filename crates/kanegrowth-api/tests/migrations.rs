mod common;
use common::*;
use rusqlite::Connection;
use std::process::Command;

#[test]
fn migrations_initialize_cleanly() {
    let db = temp_db("mig_init");
    // trigger server boot to run migrations
    let mut srv = start_server(&db, 18091);
    wait_health(18091);
    let conn = Connection::open(&db).unwrap();
    let v: i64 = conn
        .query_row("PRAGMA user_version;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 8);
    let user_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(users)").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    };
    assert!(user_columns.iter().any(|c| c == "settings"));
    for table in ["password_reset_tokens", "email_verification_tokens"] {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing table {table}");
    }
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn migrations_persist_across_reopen() {
    let db = temp_db("mig_persist");
    let mut srv = start_server(&db, 18092);
    wait_health(18092);
    // register a user
    let client = reqwest::blocking::Client::new();
    let _ = client
        .post("http://127.0.0.1:18092/api/v1/auth/register")
        .json(
            &serde_json::json!({"email":"p@example.com","password":"Password123!","fullName":"P"}),
        )
        .send()
        .unwrap();
    let _ = srv.kill();
    let _ = srv.wait();

    // second boot on same db file (must NOT delete it)
    let bin = env!("CARGO_BIN_EXE_kanegrowth-api");
    let mut srv2 = Command::new(bin)
        .env("KANEGROWTH_BIND", "127.0.0.1:18093")
        .env("KANEGROWTH_DB_PATH", &db)
        .env("KANEGROWTH_JWT_SECRET", "test-secret")
        .env("KANEGROWTH_CORS_ORIGINS", "http://localhost:8080")
        .spawn()
        .unwrap();
    // wait health
    for _ in 0..60 {
        if reqwest::blocking::get("http://127.0.0.1:18093/health").is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = srv2.kill();
    let _ = srv2.wait();

    let conn = Connection::open(&db).unwrap();
    let v: i64 = conn
        .query_row("PRAGMA user_version;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 8);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM users WHERE email='p@example.com'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(count >= 1);
}
