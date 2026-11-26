// shared helpers for integration tests
#![allow(dead_code)]

use std::process::{Child, Command};
use std::thread::sleep;
use std::time::Duration;

pub fn start_server(db_path: &str, port: u16) -> Child {
    let bin = env!("CARGO_BIN_EXE_kanegrowth-api");
    let _ = std::fs::remove_file(db_path);
    Command::new(bin)
        .env("KANEGROWTH_BIND", format!("127.0.0.1:{}", port))
        .env("KANEGROWTH_DB_PATH", db_path)
        .env("KANEGROWTH_JWT_SECRET", "test-secret")
        .env("KANEGROWTH_CORS_ORIGINS", "http://localhost:8080")
        .spawn()
        .unwrap()
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
