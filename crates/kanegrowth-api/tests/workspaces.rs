mod common;
use common::*;
use serde_json::json;

fn register_token(port: u16, email: &str) -> String {
    let client = reqwest::blocking::Client::new();
    let reg = client
        .post(format!("http://127.0.0.1:{}/api/v1/auth/register", port))
        .json(&json!({"email":email,"password":"Password123!","fullName":"U"}))
        .send()
        .unwrap();
    let v: serde_json::Value = reg.json().unwrap();
    v["data"]["token"].as_str().unwrap().to_string()
}

#[test]
fn workspace_scope_isolation() {
    let db = temp_db("ws_iso");
    let mut srv = start_server(&db, 18121);
    wait_health(18121);
    let token_a = register_token(18121, "a@example.com");
    let token_b = register_token(18121, "b@example.com");
    let client = reqwest::blocking::Client::new();
    // create workspace as user a
    let ws_resp = client
        .post("http://127.0.0.1:18121/api/v1/workspaces")
        .bearer_auth(&token_a)
        .json(&json!({"name":"WS"}))
        .send()
        .unwrap();
    let wsv: serde_json::Value = ws_resp.json().unwrap();
    let ws_id = wsv["data"]["id"].as_str().unwrap().to_string();

    // user b tries bootstrap with workspaceId -> 403
    let r = client
        .get(format!(
            "http://127.0.0.1:18121/api/v1/sync/bootstrap?workspaceId={}",
            ws_id
        ))
        .bearer_auth(&token_b)
        .send()
        .unwrap();
    assert_eq!(r.status().as_u16(), 403);

    // user b tries push with workspaceId -> 403
    let op = json!({
        "opId": "opx",
        "entity": "account",
        "operation": "create",
        "payload": {"_id":"accx","name":"Cash","type":"bank","currency":"USD","updatedAt":"2026-01-01T00:00:00Z"}
    });
    let r2 = client
        .post("http://127.0.0.1:18121/api/v1/sync/push")
        .bearer_auth(&token_b)
        .json(&json!({"workspaceId": ws_id, "ops":[op]}))
        .send()
        .unwrap();
    assert_eq!(r2.status().as_u16(), 403);
    let _ = srv.kill();
    let _ = srv.wait();
}
