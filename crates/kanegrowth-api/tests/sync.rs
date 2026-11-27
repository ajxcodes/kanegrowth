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
fn bootstrap_returns_checkpoint() {
    let db = temp_db("sync_boot");
    let mut srv = start_server(&db, 18111);
    wait_health(18111);
    let token = register_token(18111, "s@example.com");
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get("http://127.0.0.1:18111/api/v1/sync/bootstrap")
        .bearer_auth(&token)
        .send()
        .unwrap();
    assert!(resp.status().is_success());
    let v: serde_json::Value = resp.json().unwrap();
    let ckpt = v["data"]["checkpoint"].as_str().unwrap();
    assert!(!ckpt.is_empty());
    // all 10 entities arrays
    for field in [
        "accounts",
        "transactions",
        "categories",
        "budgets",
        "savingsGoals",
        "tags",
        "recurringRules",
        "categorizationRules",
        "savingsGoalContributions",
        "transactionTemplates",
    ] {
        assert!(v["data"][field].is_array(), "missing {}", field);
    }
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn push_idempotent_replay() {
    let db = temp_db("sync_idem");
    let mut srv = start_server(&db, 18112);
    wait_health(18112);
    let token = register_token(18112, "i@example.com");
    let client = reqwest::blocking::Client::new();
    let op = json!({
        "opId": "op1",
        "entity": "account",
        "operation": "create",
        "baseUpdatedAt": null,
        "payload": {"_id":"acc1","name":"Cash","type":"bank","currency":"USD","currentBalance":10,"userId":"x","updatedAt":"2026-01-01T00:00:00Z"}
    });
    let body = json!({"ops":[op.clone()]});
    let r1 = client
        .post("http://127.0.0.1:18112/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&body)
        .send()
        .unwrap();
    assert!(r1.status().is_success());
    let v1: serde_json::Value = r1.json().unwrap();
    let res1 = &v1["data"]["results"][0];
    assert_eq!(res1["status"].as_str(), Some("applied"));
    let rid1 = res1["resultId"].as_str().map(|s| s.to_string());

    // replay same opId
    let r2 = client
        .post("http://127.0.0.1:18112/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&body)
        .send()
        .unwrap();
    let v2: serde_json::Value = r2.json().unwrap();
    let res2 = &v2["data"]["results"][0];
    assert_eq!(res2["status"].as_str(), Some("noop"));
    assert_eq!(res2["resultId"].as_str().map(|s| s.to_string()), rid1);
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn push_update_conflict_returns_server_doc() {
    let db = temp_db("sync_conflict");
    let mut srv = start_server(&db, 18113);
    wait_health(18113);
    let token = register_token(18113, "c@example.com");
    let client = reqwest::blocking::Client::new();
    // create initial
    let op_create = json!({
        "opId": "oc",
        "entity": "account",
        "operation": "create",
        "payload": {"_id":"acc2","name":"Cash","type":"bank","currency":"USD","currentBalance":10,"updatedAt":"2026-01-01T00:00:00Z"}
    });
    let _ = client
        .post("http://127.0.0.1:18113/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&json!({"ops":[op_create]}))
        .send()
        .unwrap();
    // update with stale baseUpdatedAt
    let op_update = json!({
        "opId": "ou",
        "entity": "account",
        "operation": "update",
        "baseUpdatedAt": "2025-01-01T00:00:00Z",
        "payload": {"_id":"acc2","name":"Cash2","type":"bank","currency":"USD","currentBalance":20,"updatedAt":"2026-02-02T00:00:00Z"}
    });
    let r = client
        .post("http://127.0.0.1:18113/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&json!({"ops":[op_update]}))
        .send()
        .unwrap();
    let v: serde_json::Value = r.json().unwrap();
    let res = &v["data"]["results"][0];
    assert_eq!(res["status"].as_str(), Some("conflict"));
    assert_eq!(res["conflict"]["serverDoc"]["_id"].as_str(), Some("acc2"));
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn push_delete_always_applies() {
    let db = temp_db("sync_delete");
    let mut srv = start_server(&db, 18114);
    wait_health(18114);
    let token = register_token(18114, "d@example.com");
    let client = reqwest::blocking::Client::new();
    let op_create = json!({
        "opId": "ocd",
        "entity": "account",
        "operation": "create",
        "payload": {"_id":"acc3","name":"Cash","type":"bank","currency":"USD","currentBalance":10,"updatedAt":"2026-01-01T00:00:00Z"}
    });
    let _ = client
        .post("http://127.0.0.1:18114/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&json!({"ops":[op_create]}))
        .send()
        .unwrap();
    let op_delete = json!({
        "opId": "odd",
        "entity": "account",
        "operation": "delete",
        "payload": {"_id":"acc3","deletedAt":"2026-02-02T00:00:00Z"}
    });
    let r = client
        .post("http://127.0.0.1:18114/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&json!({"ops":[op_delete]}))
        .send()
        .unwrap();
    let v: serde_json::Value = r.json().unwrap();
    let res = &v["data"]["results"][0];
    assert_eq!(res["status"].as_str(), Some("applied"));
    // check db deletedAt set
    let conn = rusqlite::Connection::open(&db).unwrap();
    let del: Option<String> = conn
        .query_row("SELECT deletedAt FROM accounts WHERE _id='acc3'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(del.is_some());
    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn empty_user_id_is_repaired_on_push() {
    let db = temp_db("sync_empty_user");
    let mut srv = start_server(&db, 18138);
    wait_health(18138);
    let client = reqwest::blocking::Client::new();
    let reg = client
        .post("http://127.0.0.1:18138/api/v1/auth/register")
        .json(&json!({"email":"stale@example.com","password":"Password123!","fullName":"Stale"}))
        .send()
        .unwrap();
    let regv: serde_json::Value = reg.json().unwrap();
    let token = regv["data"]["token"].as_str().unwrap().to_string();
    let user_id = regv["data"]["user"]["_id"].as_str().unwrap().to_string();

    let op = json!({
        "opId": "op-empty-user",
        "entity": "account",
        "operation": "create",
        "payload": {
            "_id": "acc-empty-user",
            "userId": "",
            "name": "Cash",
            "type": "bank",
            "currency": "USD",
            "updatedAt": "2026-11-27T00:00:00Z"
        }
    });
    let pushed = client
        .post("http://127.0.0.1:18138/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&json!({"ops":[op]}))
        .send()
        .unwrap();
    let pushedv: serde_json::Value = pushed.json().unwrap();
    assert_eq!(
        pushedv["data"]["results"][0]["status"].as_str(),
        Some("applied")
    );

    let pulled = client
        .get("http://127.0.0.1:18138/api/v1/sync/pull")
        .bearer_auth(&token)
        .send()
        .unwrap();
    let pulledv: serde_json::Value = pulled.json().unwrap();
    let changes = pulledv["data"]["changes"].as_array().unwrap();
    let record = changes
        .iter()
        .find(|c| c["doc"]["_id"].as_str() == Some("acc-empty-user"))
        .expect("pushed account is returned on pull");
    assert_eq!(record["doc"]["userId"].as_str(), Some(user_id.as_str()));

    let _ = srv.kill();
    let _ = srv.wait();
}

#[test]
fn pull_cursor_pagination_and_tombstones() {
    let db = temp_db("sync_pull");
    let mut srv = start_server(&db, 18115);
    wait_health(18115);
    let token = register_token(18115, "p@example.com");
    let client = reqwest::blocking::Client::new();
    // bootstrap checkpoint
    let boot = client
        .get("http://127.0.0.1:18115/api/v1/sync/bootstrap")
        .bearer_auth(&token)
        .send()
        .unwrap();
    let bootv: serde_json::Value = boot.json().unwrap();
    let ckpt = bootv["data"]["checkpoint"].as_str().unwrap().to_string();
    // push a record
    let op = json!({
        "opId": "opp",
        "entity": "account",
        "operation": "create",
        "payload": {"_id":"accP","name":"Cash","type":"bank","currency":"USD","currentBalance":10,"updatedAt":"2026-03-03T00:00:00Z"}
    });
    let _ = client
        .post("http://127.0.0.1:18115/api/v1/sync/push")
        .bearer_auth(&token)
        .json(&json!({"ops":[op]}))
        .send()
        .unwrap();
    // pull from old checkpoint
    let pull1 = client
        .get(format!(
            "http://127.0.0.1:18115/api/v1/sync/pull?checkpoint={}",
            ckpt
        ))
        .bearer_auth(&token)
        .send()
        .unwrap();
    let p1: serde_json::Value = pull1.json().unwrap();
    assert!(!p1["data"]["changes"].as_array().unwrap().is_empty());
    let newckpt = p1["data"]["checkpoint"].as_str().unwrap().to_string();
    assert_ne!(newckpt, ckpt);
    // second pull empty
    let pull2 = client
        .get(format!(
            "http://127.0.0.1:18115/api/v1/sync/pull?checkpoint={}",
            newckpt
        ))
        .bearer_auth(&token)
        .send()
        .unwrap();
    let p2: serde_json::Value = pull2.json().unwrap();
    assert_eq!(p2["data"]["changes"].as_array().unwrap().len(), 0);
    assert_eq!(p2["data"]["hasMore"], false);
    let _ = srv.kill();
    let _ = srv.wait();
}
