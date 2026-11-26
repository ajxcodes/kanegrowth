mod common;
use common::*;
use serde_json::json;

#[test]
fn register_login_refresh_roundtrip() {
    let db = temp_db("auth");
    let mut srv = start_server(&db, 18101);
    wait_health(18101);
    let client = reqwest::blocking::Client::new();
    let reg = client
        .post("http://127.0.0.1:18101/api/v1/auth/register")
        .json(&json!({"email":"a@example.com","password":"Password123!","fullName":"A User"}))
        .send()
        .unwrap();
    assert!(reg.status().is_success());
    let regv: serde_json::Value = reg.json().unwrap();
    let token = regv["data"]["token"].as_str().unwrap().to_string();
    let refresh = regv["data"]["refreshToken"].as_str().unwrap().to_string();
    // /auth/user
    let user_resp = client
        .get("http://127.0.0.1:18101/api/v1/auth/user")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert!(user_resp.status().is_success());
    let userv: serde_json::Value = user_resp.json().unwrap();
    assert_eq!(userv["data"]["email"].as_str(), Some("a@example.com"));
    // login
    let login = client
        .post("http://127.0.0.1:18101/api/v1/auth/login")
        .json(&json!({"email":"a@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert!(login.status().is_success());
    // refresh
    let refr = client
        .post("http://127.0.0.1:18101/api/v1/auth/refresh")
        .json(&json!({"refreshToken": refresh}))
        .send()
        .unwrap();
    assert!(refr.status().is_success());
    let refrv: serde_json::Value = refr.json().unwrap();
    assert!(refrv["data"]["token"].as_str().is_some());
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn logout_revokes_refresh_token() {
    let db = temp_db("logout");
    let mut srv = start_server(&db, 18102);
    wait_health(18102);
    let client = reqwest::blocking::Client::new();
    let reg = client
        .post("http://127.0.0.1:18102/api/v1/auth/register")
        .json(&json!({"email":"b@example.com","password":"Password123!","fullName":"B"}))
        .send()
        .unwrap();
    let regv: serde_json::Value = reg.json().unwrap();
    let refresh = regv["data"]["refreshToken"].as_str().unwrap().to_string();
    // logout
    let _ = client
        .post("http://127.0.0.1:18102/api/v1/auth/logout")
        .json(&json!({"refreshToken": refresh}))
        .send()
        .unwrap();
    // refresh should fail
    let refr = client
        .post("http://127.0.0.1:18102/api/v1/auth/refresh")
        .json(&json!({"refreshToken": refresh}))
        .send()
        .unwrap();
    assert_eq!(refr.status().as_u16(), 401);
    let _ = srv.kill();
    let _ = srv.wait();
}
