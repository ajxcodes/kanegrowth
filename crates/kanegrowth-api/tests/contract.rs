mod common;
use common::*;
use serde_json::{json, Value};

#[test]
fn auth_and_workspace_dto_contract() {
    let db = temp_db("contract");
    let mut srv = start_server(&db, 18131);
    wait_health(18131);

    let fixture: Value =
        serde_json::from_str(include_str!("../../../shared/fixtures/contract/auth.json")).unwrap();
    let fixture_user = fixture["auth"]["user"].as_object().unwrap();
    let fixture_workspace = fixture["workspace"].as_object().unwrap();

    let client = reqwest::blocking::Client::new();
    let reg = client
        .post("http://127.0.0.1:18131/api/v1/auth/register")
        .json(&json!({"email":"contract@example.com","password":"Password123!","fullName":"Contract User"}))
        .send()
        .unwrap();
    assert!(reg.status().is_success());
    let regv: Value = reg.json().unwrap();
    let token = regv["data"]["token"].as_str().unwrap().to_string();
    let user = regv["data"]["user"].as_object().unwrap();
    for key in fixture_user.keys() {
        assert!(
            user.contains_key(key),
            "user payload missing fixture key {key}: {user:?}"
        );
    }
    for key in fixture["forbiddenUserKeys"].as_array().unwrap() {
        let key = key.as_str().unwrap();
        assert!(
            !user.contains_key(key),
            "legacy user key {key} still emitted"
        );
    }
    assert_eq!(
        user["legalVersions"]["termsVersion"].as_str(),
        Some("2026-08-29")
    );

    let ws_resp = client
        .get("http://127.0.0.1:18131/api/v1/workspaces")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert!(ws_resp.status().is_success());
    let wsv: Value = ws_resp.json().unwrap();
    let workspace = wsv["data"][0].as_object().unwrap();
    for key in fixture_workspace.keys() {
        assert!(
            workspace.contains_key(key),
            "workspace payload missing fixture key {key}: {workspace:?}"
        );
    }
    for key in fixture["forbiddenWorkspaceKeys"].as_array().unwrap() {
        let key = key.as_str().unwrap();
        assert!(
            !workspace.contains_key(key),
            "legacy workspace key {key} still emitted"
        );
    }
    let members = workspace["members"].as_array().unwrap();
    assert!(!members.is_empty());
    for member in members {
        let role = member["role"].as_str().unwrap();
        assert!(
            ["owner", "editor", "viewer"].contains(&role),
            "unexpected member role {role}"
        );
    }

    let _ = srv.kill();
    let _ = srv.wait();
}
