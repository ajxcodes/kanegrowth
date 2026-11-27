mod common;
use common::*;
use serde_json::{json, Value};

#[test]
fn register_login_refresh_payloads_carry_user_id() {
    let db = temp_db("auth_user_id");
    let mut srv = start_server(&db, 18132);
    wait_health(18132);
    let client = reqwest::blocking::Client::new();

    let reg = client
        .post("http://127.0.0.1:18132/api/v1/auth/register")
        .json(&json!({"email":"ids@example.com","password":"Password123!","fullName":"Ids User"}))
        .send()
        .unwrap();
    assert!(reg.status().is_success());
    let regv: Value = reg.json().unwrap();
    let reg_id = regv["data"]["user"]["_id"].as_str().unwrap().to_string();
    assert!(!reg_id.is_empty());
    assert!(regv["data"]["user"].get("id").is_none());
    let refresh = regv["data"]["refreshToken"].as_str().unwrap().to_string();

    let login = client
        .post("http://127.0.0.1:18132/api/v1/auth/login")
        .json(&json!({"email":"ids@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert!(login.status().is_success());
    let loginv: Value = login.json().unwrap();
    assert_eq!(
        loginv["data"]["user"]["_id"].as_str(),
        Some(reg_id.as_str())
    );
    assert!(loginv["data"]["user"].get("id").is_none());

    let refreshed = client
        .post("http://127.0.0.1:18132/api/v1/auth/refresh")
        .json(&json!({"refreshToken": refresh}))
        .send()
        .unwrap();
    assert!(refreshed.status().is_success());
    let refreshv: Value = refreshed.json().unwrap();
    assert_eq!(
        refreshv["data"]["user"]["_id"].as_str(),
        Some(reg_id.as_str())
    );
    assert!(refreshv["data"]["user"].get("id").is_none());

    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn patch_user_updates_whitelisted_profile_fields() {
    let db = temp_db("auth_patch_user");
    let mut srv = start_server(&db, 18133);
    wait_health(18133);
    let client = reqwest::blocking::Client::new();

    let reg = client
        .post("http://127.0.0.1:18133/api/v1/auth/register")
        .json(&json!({"email":"patch@example.com","password":"Password123!","fullName":"Before"}))
        .send()
        .unwrap();
    let regv: Value = reg.json().unwrap();
    let token = regv["data"]["token"].as_str().unwrap().to_string();
    let original_id = regv["data"]["user"]["_id"].as_str().unwrap().to_string();

    let patched = client
        .patch("http://127.0.0.1:18133/api/v1/auth/user")
        .bearer_auth(&token)
        .json(&json!({
            "fullName": "Renamed",
            "timezone": "America/New_York",
            "preferredCurrency": "EUR",
            "dateFormat": "dd/mm/yy",
            "pageSize": 25,
            "notificationPreferences": {"billRemindersEnabled": true, "billReminderDaysBefore": 5}
        }))
        .send()
        .unwrap();
    assert_eq!(patched.status().as_u16(), 200);
    let patchedv: Value = patched.json().unwrap();
    let user = &patchedv["data"];
    assert_eq!(user["fullName"].as_str(), Some("Renamed"));
    assert_eq!(user["timezone"].as_str(), Some("America/New_York"));
    assert_eq!(user["preferredCurrency"].as_str(), Some("EUR"));
    assert_eq!(user["dateFormat"].as_str(), Some("dd/mm/yy"));
    assert_eq!(user["pageSize"].as_i64(), Some(25));
    assert_eq!(
        user["notificationPreferences"]["billReminderDaysBefore"].as_i64(),
        Some(5)
    );

    let fetched = client
        .get("http://127.0.0.1:18133/api/v1/auth/user")
        .bearer_auth(&token)
        .send()
        .unwrap();
    let fetchedv: Value = fetched.json().unwrap();
    assert_eq!(fetchedv["data"]["fullName"].as_str(), Some("Renamed"));
    assert_eq!(
        fetchedv["data"]["timezone"].as_str(),
        Some("America/New_York")
    );

    let immutable = client
        .patch("http://127.0.0.1:18133/api/v1/auth/user")
        .bearer_auth(&token)
        .json(&json!({"email":"evil@example.com","_id":"x","isEmailVerified":false}))
        .send()
        .unwrap();
    assert_eq!(immutable.status().as_u16(), 200);
    let immutablev: Value = immutable.json().unwrap();
    assert_eq!(
        immutablev["data"]["email"].as_str(),
        Some("patch@example.com")
    );
    assert_eq!(
        immutablev["data"]["_id"].as_str(),
        Some(original_id.as_str())
    );
    assert_eq!(immutablev["data"]["isEmailVerified"].as_bool(), Some(true));

    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn password_reset_request_and_confirm_rotates_credentials() {
    let db = temp_db("auth_password_reset");
    let mut srv = start_server(&db, 18134);
    wait_health(18134);
    let client = reqwest::blocking::Client::new();

    let reg = client
        .post("http://127.0.0.1:18134/api/v1/auth/register")
        .json(
            &json!({"email":"reset@example.com","password":"Password123!","fullName":"Reset User"}),
        )
        .send()
        .unwrap();
    let regv: Value = reg.json().unwrap();
    let old_refresh = regv["data"]["refreshToken"].as_str().unwrap().to_string();

    let known = client
        .post("http://127.0.0.1:18134/api/v1/auth/password-reset/request")
        .json(&json!({"email":"reset@example.com"}))
        .send()
        .unwrap();
    assert_eq!(known.status().as_u16(), 200);
    let knownv: Value = known.json().unwrap();
    let unknown = client
        .post("http://127.0.0.1:18134/api/v1/auth/password-reset/request")
        .json(&json!({"email":"nobody@example.com"}))
        .send()
        .unwrap();
    assert_eq!(unknown.status().as_u16(), 200);
    let unknownv: Value = unknown.json().unwrap();
    assert_eq!(knownv["data"]["message"], unknownv["data"]["message"]);
    assert!(unknownv["data"].get("devToken").is_none());
    let reset_token = knownv["data"]["devToken"].as_str().unwrap().to_string();
    assert!(!reset_token.is_empty());

    let confirm = client
        .post("http://127.0.0.1:18134/api/v1/auth/password-reset/confirm")
        .json(&json!({"token": reset_token, "password": "NewPassword123!"}))
        .send()
        .unwrap();
    assert_eq!(confirm.status().as_u16(), 200);

    let old_login = client
        .post("http://127.0.0.1:18134/api/v1/auth/login")
        .json(&json!({"email":"reset@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert_eq!(old_login.status().as_u16(), 401);
    let new_login = client
        .post("http://127.0.0.1:18134/api/v1/auth/login")
        .json(&json!({"email":"reset@example.com","password":"NewPassword123!"}))
        .send()
        .unwrap();
    assert_eq!(new_login.status().as_u16(), 200);

    let stale_refresh = client
        .post("http://127.0.0.1:18134/api/v1/auth/refresh")
        .json(&json!({"refreshToken": old_refresh}))
        .send()
        .unwrap();
    assert_eq!(stale_refresh.status().as_u16(), 401);

    let replay = client
        .post("http://127.0.0.1:18134/api/v1/auth/password-reset/confirm")
        .json(&json!({"token": reset_token, "password": "NewPassword123!"}))
        .send()
        .unwrap();
    assert_eq!(replay.status().as_u16(), 400);

    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn email_verification_defaults_verified_and_can_be_enforced() {
    let client = reqwest::blocking::Client::new();

    // Flag off (the self-hosted default): registrations are verified and a bogus confirm is 400.
    let db = temp_db("auth_ev_off");
    let mut srv = start_server(&db, 18135);
    wait_health(18135);
    let reg = client
        .post("http://127.0.0.1:18135/api/v1/auth/register")
        .json(&json!({"email":"verified@example.com","password":"Password123!","fullName":"Verified"}))
        .send()
        .unwrap();
    let regv: Value = reg.json().unwrap();
    assert_eq!(
        regv["data"]["user"]["isEmailVerified"].as_bool(),
        Some(true)
    );
    let token = regv["data"]["token"].as_str().unwrap().to_string();
    let resend = client
        .post("http://127.0.0.1:18135/api/v1/auth/email-verification/resend")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert_eq!(resend.status().as_u16(), 200);
    let resendv: Value = resend.json().unwrap();
    assert!(resendv["data"]["message"].as_str().is_some());
    let bogus = client
        .post("http://127.0.0.1:18135/api/v1/auth/email-verification/confirm")
        .json(&json!({"token":"bogus"}))
        .send()
        .unwrap();
    assert_eq!(bogus.status().as_u16(), 400);
    let _ = srv.kill();
    let _ = srv.wait();

    // Flag on: unverified until the emailed token is confirmed, and login is 403 meanwhile.
    let db = temp_db("auth_ev_on");
    let mut srv = start_server_with_env(
        &db,
        18136,
        &[("KANEGROWTH_REQUIRE_EMAIL_VERIFICATION", "1")],
    );
    wait_health(18136);
    let reg = client
        .post("http://127.0.0.1:18136/api/v1/auth/register")
        .json(
            &json!({"email":"pending@example.com","password":"Password123!","fullName":"Pending"}),
        )
        .send()
        .unwrap();
    let regv: Value = reg.json().unwrap();
    assert_eq!(
        regv["data"]["user"]["isEmailVerified"].as_bool(),
        Some(false)
    );
    let token = regv["data"]["token"].as_str().unwrap().to_string();
    let login = client
        .post("http://127.0.0.1:18136/api/v1/auth/login")
        .json(&json!({"email":"pending@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert_eq!(login.status().as_u16(), 403);
    let resend = client
        .post("http://127.0.0.1:18136/api/v1/auth/email-verification/resend")
        .bearer_auth(&token)
        .send()
        .unwrap();
    let resendv: Value = resend.json().unwrap();
    let dev_token = resendv["data"]["devToken"].as_str().unwrap().to_string();
    let confirm = client
        .post("http://127.0.0.1:18136/api/v1/auth/email-verification/confirm")
        .json(&json!({"token": dev_token}))
        .send()
        .unwrap();
    assert_eq!(confirm.status().as_u16(), 200);
    let login = client
        .post("http://127.0.0.1:18136/api/v1/auth/login")
        .json(&json!({"email":"pending@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert_eq!(login.status().as_u16(), 200);
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn email_verification_resend_accepts_a_signed_out_email() {
    let db = temp_db("auth_ev_signed_out");
    let mut srv = start_server_with_env(
        &db,
        18140,
        &[("KANEGROWTH_REQUIRE_EMAIL_VERIFICATION", "1")],
    );
    wait_health(18140);
    let client = reqwest::blocking::Client::new();

    let reg = client
        .post("http://127.0.0.1:18140/api/v1/auth/register")
        .json(&json!({"email":"signedout@example.com","password":"Password123!","fullName":"Signed Out"}))
        .send()
        .unwrap();
    assert!(reg.status().is_success());

    // Signed out (no bearer token): the bounced-login flow posts only the address.
    let resend = client
        .post("http://127.0.0.1:18140/api/v1/auth/email-verification/resend")
        .json(&json!({"email":"signedout@example.com"}))
        .send()
        .unwrap();
    assert_eq!(resend.status().as_u16(), 200);
    let resendv: Value = resend.json().unwrap();
    let message = resendv["data"]["message"]
        .as_str()
        .expect("generic message")
        .to_string();
    let dev_token = resendv["data"]["devToken"]
        .as_str()
        .expect("known address issues a dev token")
        .to_string();

    // An unknown address gets the identical 200 and never a token.
    let unknown = client
        .post("http://127.0.0.1:18140/api/v1/auth/email-verification/resend")
        .json(&json!({"email":"nobody@example.com"}))
        .send()
        .unwrap();
    assert_eq!(unknown.status().as_u16(), 200);
    let unknownv: Value = unknown.json().unwrap();
    assert_eq!(unknownv["data"]["message"].as_str(), Some(message.as_str()));
    assert!(unknownv["data"].get("devToken").is_none());

    let confirm = client
        .post("http://127.0.0.1:18140/api/v1/auth/email-verification/confirm")
        .json(&json!({"token": dev_token}))
        .send()
        .unwrap();
    assert_eq!(confirm.status().as_u16(), 200);
    let login = client
        .post("http://127.0.0.1:18140/api/v1/auth/login")
        .json(&json!({"email":"signedout@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert_eq!(login.status().as_u16(), 200);
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn delete_account_requires_the_password_and_removes_the_user() {
    let db = temp_db("auth_delete");
    let mut srv = start_server(&db, 18139);
    wait_health(18139);
    let client = reqwest::blocking::Client::new();

    let reg = client
        .post("http://127.0.0.1:18139/api/v1/auth/register")
        .json(&json!({"email":"delete@example.com","password":"Password123!","fullName":"Delete"}))
        .send()
        .unwrap();
    let regv: Value = reg.json().unwrap();
    let token = regv["data"]["token"].as_str().unwrap().to_string();

    let impact = client
        .get("http://127.0.0.1:18139/api/v1/auth/account/deletion-impact")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert_eq!(impact.status().as_u16(), 200);
    let impactv: Value = impact.json().unwrap();
    assert_eq!(impactv["data"]["retainedRecordCount"].as_i64(), Some(0));
    assert_eq!(
        impactv["data"]["affectedWorkspaces"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let wrong = client
        .delete("http://127.0.0.1:18139/api/v1/auth/account")
        .bearer_auth(&token)
        .json(&json!({"password":"wrong-password"}))
        .send()
        .unwrap();
    assert_eq!(wrong.status().as_u16(), 400);
    let still = client
        .get("http://127.0.0.1:18139/api/v1/auth/user")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert_eq!(still.status().as_u16(), 200);

    let deleted = client
        .delete("http://127.0.0.1:18139/api/v1/auth/account")
        .bearer_auth(&token)
        .json(&json!({"password":"Password123!"}))
        .send()
        .unwrap();
    assert_eq!(deleted.status().as_u16(), 200);
    let login = client
        .post("http://127.0.0.1:18139/api/v1/auth/login")
        .json(&json!({"email":"delete@example.com","password":"Password123!"}))
        .send()
        .unwrap();
    assert_eq!(login.status().as_u16(), 401);

    let _ = srv.kill();
    let _ = srv.wait();
}

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
