mod common;
use common::*;

#[test]
fn health_endpoint_returns_ok() {
    let db = temp_db("health");
    let mut srv = start_server(&db, 18081);
    wait_health(18081);
    let resp = reqwest::blocking::get("http://127.0.0.1:18081/health").unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().unwrap();
    assert_eq!(body.get("status").and_then(|v| v.as_str()), Some("ok"));
    let _ = srv.kill();
    let _ = srv.wait();
}
