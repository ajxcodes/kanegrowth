mod common;
use common::*;
use serde_json::{json, Value};

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

fn register(port: u16, email: &str) -> Value {
    let client = reqwest::blocking::Client::new();
    let reg = client
        .post(format!("http://127.0.0.1:{}/api/v1/auth/register", port))
        .json(&json!({"email":email,"password":"Password123!","fullName":"U"}))
        .send()
        .unwrap();
    reg.json().unwrap()
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
    let ws_id = wsv["data"]["_id"].as_str().unwrap().to_string();

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

#[test]
fn workspace_dto_exposes_id_owner_and_members() {
    let db = temp_db("ws_dto");
    let mut srv = start_server(&db, 18137);
    wait_health(18137);
    let client = reqwest::blocking::Client::new();
    let reg = register(18137, "shape@example.com");
    let token = reg["data"]["token"].as_str().unwrap().to_string();
    let user_id = reg["data"]["user"]["_id"].as_str().unwrap().to_string();

    let list = client
        .get("http://127.0.0.1:18137/api/v1/workspaces")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert_eq!(list.status().as_u16(), 200);
    let listv: Value = list.json().unwrap();
    let workspace = &listv["data"][0];
    let workspace_id = workspace["_id"].as_str().unwrap().to_string();
    assert!(!workspace_id.is_empty());
    assert_eq!(workspace["ownerId"].as_str(), Some(user_id.as_str()));
    assert!(workspace.get("id").is_none());
    assert!(workspace.get("ownerUserId").is_none());
    let members = workspace["members"].as_array().unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0]["userId"].as_str(), Some(user_id.as_str()));
    assert_eq!(members[0]["role"].as_str(), Some("owner"));

    let patched = client
        .patch(format!(
            "http://127.0.0.1:18137/api/v1/workspaces/{}",
            workspace_id
        ))
        .bearer_auth(&token)
        .json(&json!({"name":"Renamed Household"}))
        .send()
        .unwrap();
    assert_eq!(patched.status().as_u16(), 200);
    let patchedv: Value = patched.json().unwrap();
    assert_eq!(patchedv["data"]["name"].as_str(), Some("Renamed Household"));
    assert_eq!(
        patchedv["data"]["members"][0]["role"].as_str(),
        Some("owner")
    );

    let _ = srv.kill();
    let _ = srv.wait();
}
