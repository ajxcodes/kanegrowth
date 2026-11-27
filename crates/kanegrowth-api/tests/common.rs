// shared helpers for integration tests
#![allow(dead_code)]

use std::process::{Child, Command};
use std::thread::sleep;
use std::time::Duration;

/// The committed test-only ES256 keypair, shared with the web/Vitest fixtures so the two
/// languages can never drift. Returns `(private_key, public_key)` PEMs.
pub fn offline_grant_test_keypair() -> (String, String) {
    let raw: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/fixtures/contract/offline-grant-test-keypair.json"
    ))
    .unwrap();
    (
        raw["privateKey"].as_str().unwrap().to_string(),
        raw["publicKey"].as_str().unwrap().to_string(),
    )
}

pub fn start_server_with_env(db_path: &str, port: u16, extra: &[(&str, &str)]) -> Child {
    let bin = env!("CARGO_BIN_EXE_kanegrowth-api");
    let _ = std::fs::remove_file(db_path);
    let mut command = Command::new(bin);
    command
        .env("KANEGROWTH_BIND", format!("127.0.0.1:{}", port))
        .env("KANEGROWTH_DB_PATH", db_path)
        .env("KANEGROWTH_JWT_SECRET", "test-secret")
        .env("KANEGROWTH_CORS_ORIGINS", "http://localhost:8080")
        // New auth-route tests read `data.devToken`; existing suites ignore the extra field.
        .env("KANEGROWTH_DEV_AUTH_TOKENS", "1");
    // Every started server can mint verifiable offline grants by default; `extra` may override
    // the key (including to "") for the fail-open test.
    let (private_key, _public_key) = offline_grant_test_keypair();
    command.env("KANEGROWTH_OFFLINE_GRANT_PRIVATE_KEY", private_key);
    for (key, value) in extra {
        command.env(key, value);
    }
    command.spawn().unwrap()
}

pub fn start_server(db_path: &str, port: u16) -> Child {
    start_server_with_env(db_path, port, &[])
}

pub fn wait_health(port: u16) {
    for _ in 0..60 {
        if reqwest::blocking::get(format!("http://127.0.0.1:{}/health", port)).is_ok() {
            return;
        }
        sleep(Duration::from_millis(100));
    }
    panic!("server not ready");
}

pub fn temp_db(name: &str) -> String {
    let mut p = std::env::temp_dir();
    p.push(format!("kg_test_{}_{}.db", name, std::process::id()));
    let _ = std::fs::remove_file(&p);
    p.to_string_lossy().to_string()
}
