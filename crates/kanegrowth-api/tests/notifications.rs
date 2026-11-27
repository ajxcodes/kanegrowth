//! Integration coverage for the notification pipeline (issue #16).
//!
//! A tiny in-process ntfy listener stands in for the compose service so delivery, retry and
//! failure isolation are exercised without Docker. Ports for the API servers stay inside
//! 18150-18169, outside every other suite's range.

mod common;

use common::{start_server_with_env, temp_db, wait_health};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const PASSWORD: &str = "Password123!";

// --- mock ntfy ---

struct MockNtfy {
    base_url: String,
    hits: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl MockNtfy {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = Arc::clone(&hits);
        let stop_flag = Arc::clone(&stop);

        let handle = thread::spawn(move || {
            while !stop_flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut raw = Vec::new();
                        let mut buf = [0u8; 4096];
                        loop {
                            match stream.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    raw.extend_from_slice(&buf[..n]);
                                    if n < buf.len() {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        captured
                            .lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&raw).to_string());
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        let _ = stream.flush();
                    }
                    Err(ref err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            base_url: format!("http://{addr}"),
            hits,
            stop,
            handle: Some(handle),
        }
    }

    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

impl Drop for MockNtfy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(self.base_url.trim_start_matches("http://"));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

// --- server helpers ---

struct ApiServer {
    child: Child,
    base: String,
}

impl Drop for ApiServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn boot(db: &str, port: u16, extra: &[(&str, &str)]) -> ApiServer {
    let child = start_server_with_env(db, port, extra);
    wait_health(port);
    ApiServer {
        child,
        base: format!("http://127.0.0.1:{port}/api/v1"),
    }
}

/// Like `boot`, but keeps an existing database file (used by the restart test).
fn reboot_existing(db: &str, port: u16) -> ApiServer {
    let bin = env!("CARGO_BIN_EXE_kanegrowth-api");
    let child = Command::new(bin)
        .env("KANEGROWTH_BIND", format!("127.0.0.1:{port}"))
        .env("KANEGROWTH_DB_PATH", db)
        .env("KANEGROWTH_JWT_SECRET", "test-secret")
        .env("KANEGROWTH_CORS_ORIGINS", "http://localhost:8080")
        .env("KANEGROWTH_DEV_AUTH_TOKENS", "1")
        .spawn()
        .unwrap();
    wait_health(port);
    ApiServer {
        child,
        base: format!("http://127.0.0.1:{port}/api/v1"),
    }
}

fn stop(mut server: ApiServer) {
    let _ = server.child.kill();
    let _ = server.child.wait();
}

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

fn register(api: &str, email: &str) -> (String, String) {
    let response = client()
        .post(format!("{api}/auth/register"))
        .json(&json!({"email": email, "password": PASSWORD, "fullName": "Notify Tester"}))
        .send()
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "register failed");
    let body: Value = response.json().unwrap();
    (
        body["data"]["token"].as_str().unwrap().to_string(),
        body["data"]["user"]["_id"].as_str().unwrap().to_string(),
    )
}

fn get(api: &str, token: &str, path: &str) -> (StatusCode, Value) {
    let response = client()
        .get(format!("{api}{path}"))
        .bearer_auth(token)
        .send()
        .unwrap();
    let status = response.status();
    (status, response.json().unwrap_or(Value::Null))
}

fn post(api: &str, token: &str, path: &str, body: &Value) -> (StatusCode, Value) {
    let response = client()
        .post(format!("{api}{path}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .unwrap();
    let status = response.status();
    (status, response.json().unwrap_or(Value::Null))
}

fn patch(api: &str, token: &str, path: &str, body: &Value) -> (StatusCode, Value) {
    let response = client()
        .patch(format!("{api}{path}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .unwrap();
    let status = response.status();
    (status, response.json().unwrap_or(Value::Null))
}

fn delete(api: &str, token: &str, path: &str, body: &Value) -> (StatusCode, Value) {
    let response = client()
        .delete(format!("{api}{path}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .unwrap();
    let status = response.status();
    (status, response.json().unwrap_or(Value::Null))
}

fn notifications(api: &str, token: &str) -> Value {
    let (status, body) = get(api, token, "/notifications");
    assert_eq!(status, StatusCode::OK, "list failed: {body}");
    body["data"].clone()
}

fn rows_of_type(payload: &Value, kind: &str) -> Vec<Value> {
    payload["notifications"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row["type"] == kind)
        .collect()
}

/// Polls `GET /notifications` until `id` reports `expected` status (bounded, no sleeps beyond the
/// poll interval).
fn wait_for_status(api: &str, token: &str, id: &str, expected: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let payload = notifications(api, token);
        if let Some(row) = payload["notifications"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["_id"] == id))
        {
            if row["ntfyStatus"] == expected {
                return row.clone();
            }
        }
        if Instant::now() >= deadline {
            panic!("notification {id} never reached {expected}: {payload}");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn push(api: &str, token: &str, ops: Vec<Value>) -> Value {
    let (status, body) = post(api, token, "/sync/push", &json!({ "ops": ops }));
    assert_eq!(status, StatusCode::OK, "push failed: {body}");
    body["data"].clone()
}

fn op(op_id: &str, entity: &str, payload: Value) -> Value {
    json!({
        "opId": op_id,
        "entity": entity,
        "operation": "create",
        "payload": payload,
    })
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn budget_record(user_id: &str, id: &str, amount: i64) -> Value {
    let now = chrono::Utc::now();
    json!({
        "_id": id,
        "userId": user_id,
        "workspaceId": null,
        "name": "Food",
        "categoryId": "cat-food",
        "periodStart": (now - chrono::Duration::days(1)).to_rfc3339(),
        "periodEnd": (now + chrono::Duration::days(1)).to_rfc3339(),
        "amount": amount,
        "accountIds": [],
        "isArchived": false,
        "updatedAt": now.to_rfc3339(),
    })
}

fn expense_record(user_id: &str, id: &str, amount: i64) -> Value {
    expense_record_on(user_id, id, amount, &today())
}

fn expense_record_on(user_id: &str, id: &str, amount: i64, date: &str) -> Value {
    json!({
        "_id": id,
        "userId": user_id,
        "workspaceId": null,
        "accountId": "acc-checking",
        "categoryId": "cat-food",
        "type": "expense",
        "status": "posted",
        "amount": amount,
        "date": date,
        "hasSplitChildren": false,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    })
}

fn account_record(user_id: &str, id: &str, name: &str) -> Value {
    json!({
        "_id": id,
        "userId": user_id,
        "name": name,
        "type": "checking",
        "currency": "USD",
        "currentBalance": 0,
        "isArchived": false,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    })
}

// --- TR-8 ---

#[test]
fn events_api_creates_an_in_app_notification_and_publishes_to_ntfy() {
    let db = temp_db("notif_delivery");
    let mock = MockNtfy::spawn();
    let api = boot(
        &db,
        18150,
        &[
            ("NTFY_URL", mock.base_url.as_str()),
            ("NTFY_TOPIC", "test-topic"),
        ],
    );
    let (token, _user_id) = register(&api.base, "delivery@example.com");

    let (status, body) = post(
        &api.base,
        &token,
        "/notifications/events",
        &json!({
            "type": "bill_due",
            "title": "Rent due",
            "message": "Rent is due tomorrow",
            "dedupeKey": "delivery-1",
        }),
    );
    assert_eq!(status, StatusCode::OK, "event POST failed: {body}");

    let row = wait_for_status(
        &api.base,
        &token,
        body["data"]["notification"]["_id"].as_str().unwrap(),
        "sent",
    );
    assert_eq!(row["type"], "bill_due");

    let hits = mock.hits();
    assert_eq!(hits.len(), 1, "expected one publish, got {hits:?}");
    assert!(hits[0].contains("\"topic\":\"test-topic\""), "{}", hits[0]);
    assert!(hits[0].contains("Rent due"), "{}", hits[0]);
}

// --- TR-9 ---

#[test]
fn unconfigured_ntfy_degrades_to_in_app_only() {
    let db = temp_db("notif_unconfigured");
    let api = boot(
        &db,
        18151,
        &[("NTFY_URL", ""), ("NTFY_TOPIC", ""), ("NTFY_TOKEN", "")],
    );
    let (token, _user_id) = register(&api.base, "unconfigured@example.com");

    let (status, body) = post(
        &api.base,
        &token,
        "/notifications/events",
        &json!({"type": "maintenance_due", "title": "HVAC filter", "dedupeKey": "skip-1"}),
    );
    assert_eq!(status, StatusCode::OK, "event POST failed: {body}");

    let payload = notifications(&api.base, &token);
    let rows = rows_of_type(&payload, "maintenance_due");
    assert_eq!(rows.len(), 1, "{payload}");
    assert_eq!(rows[0]["ntfyStatus"], "skipped", "{payload}");
}

// --- TR-10 ---

#[test]
fn ntfy_failure_is_isolated_from_the_request() {
    let db = temp_db("notif_failure");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);

    let api = boot(
        &db,
        18152,
        &[
            ("NTFY_URL", closed_url.as_str()),
            ("NTFY_TOPIC", "test-topic"),
        ],
    );
    let (token, _user_id) = register(&api.base, "failure@example.com");

    let (status, body) = post(
        &api.base,
        &token,
        "/notifications/events",
        &json!({"type": "maintenance_due", "title": "Leaky tap", "dedupeKey": "fail-1"}),
    );
    assert_eq!(
        status,
        StatusCode::OK,
        "event POST must still succeed: {body}"
    );

    let id = body["data"]["notification"]["_id"].as_str().unwrap();
    let row = wait_for_status(&api.base, &token, id, "failed");
    assert!(
        row["ntfyError"]
            .as_str()
            .map(|e| !e.is_empty())
            .unwrap_or(false),
        "expected a non-empty ntfyError: {row}"
    );
}

// --- TR-11 ---

#[test]
fn notification_list_read_dismiss_and_read_all_are_owner_scoped() {
    let db = temp_db("notif_scoping");
    let api = boot(&db, 18153, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token_a, _a) = register(&api.base, "scope-a@example.com");
    let (token_b, _b) = register(&api.base, "scope-b@example.com");

    for (title, key) in [("First", "scope-1"), ("Second", "scope-2")] {
        let (status, body) = post(
            &api.base,
            &token_a,
            "/notifications/events",
            &json!({"type": "maintenance_due", "title": title, "dedupeKey": key}),
        );
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let payload = notifications(&api.base, &token_a);
    let rows = rows_of_type(&payload, "maintenance_due");
    assert_eq!(rows.len(), 2);
    assert_eq!(payload["unreadCount"], 2);
    let first_id = rows[0]["_id"].as_str().unwrap().to_string();

    let (status, _) = patch(
        &api.base,
        &token_b,
        &format!("/notifications/{first_id}/read"),
        &json!({}),
    );
    assert_eq!(status, StatusCode::NOT_FOUND, "foreign read must be a 404");
    let (status, _) = patch(
        &api.base,
        &token_b,
        &format!("/notifications/{first_id}/dismiss"),
        &json!({}),
    );
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "foreign dismiss must be a 404"
    );

    let (status, _) = patch(&api.base, &token_a, "/notifications/read-all", &json!({}));
    assert_eq!(status, StatusCode::OK);
    let payload = notifications(&api.base, &token_a);
    assert_eq!(payload["unreadCount"], 0, "{payload}");

    let (status, _) = patch(
        &api.base,
        &token_a,
        &format!("/notifications/{first_id}/dismiss"),
        &json!({}),
    );
    assert_eq!(status, StatusCode::OK);
    let payload = notifications(&api.base, &token_a);
    let rows = rows_of_type(&payload, "maintenance_due");
    assert_eq!(rows.len(), 1, "dismissed rows must disappear: {payload}");
    assert_ne!(rows[0]["_id"], first_id);
}

// --- TR-12 ---

#[test]
fn preferences_persist_across_a_restart_and_gate_budget_alerts() {
    let db = temp_db("notif_prefs");
    let mut server = boot(&db, 18154, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, user_id) = register(&server.base, "prefs@example.com");

    let (status, body) = patch(
        &server.base,
        &token,
        "/notifications/preferences",
        &json!({"billReminderDaysBefore": 7, "budgetAlertThresholdPercent": 50}),
    );
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["billReminderDaysBefore"], 7, "{body}");
    assert_eq!(body["data"]["budgetAlertThresholdPercent"], 50, "{body}");
    assert_eq!(body["data"]["syncNotificationsEnabled"], false, "{body}");

    let (status, user_body) = get(&server.base, &token, "/auth/user");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        user_body["data"]["notificationPreferences"]["billReminderDaysBefore"], 7,
        "{user_body}"
    );
    assert_eq!(
        user_body["data"]["notificationPreferences"]["budgetAlertThresholdPercent"], 50,
        "{user_body}"
    );

    // Restart on the same file: preferences are in `users.settings`, not memory.
    stop(server);
    server = reboot_existing(&db, 18154);
    let (status, body) = get(&server.base, &token, "/notifications/preferences");
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["billReminderDaysBefore"], 7, "{body}");
    assert_eq!(body["data"]["budgetAlertThresholdPercent"], 50, "{body}");

    // With budget alerts muted, the TR-13 scenario produces no budget row.
    let (status, body) = patch(
        &server.base,
        &token,
        "/notifications/preferences",
        &json!({"budgetAlertsEnabled": false}),
    );
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["billRemindersEnabled"], true, "{body}");

    push(
        &server.base,
        &token,
        vec![
            op(
                "prefs-budget",
                "budget",
                budget_record(&user_id, "budget-muted", 10000),
            ),
            op(
                "prefs-expense",
                "transaction",
                expense_record(&user_id, "expense-muted", 12000),
            ),
        ],
    );
    let payload = notifications(&server.base, &token);
    assert_eq!(
        rows_of_type(&payload, "budget_over_limit").len(),
        0,
        "a muted budget alert must create no row: {payload}"
    );
}

// --- TR-13 ---

#[test]
fn a_pushed_budget_and_expense_emit_one_over_limit_notification() {
    let db = temp_db("notif_budget");
    let api = boot(&db, 18155, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, user_id) = register(&api.base, "budget@example.com");

    let budget = budget_record(&user_id, "budget-food", 10000);
    push(
        &api.base,
        &token,
        vec![
            op("budget-1", "budget", budget.clone()),
            op(
                "expense-1",
                "transaction",
                expense_record(&user_id, "expense-food", 12000),
            ),
        ],
    );

    let payload = notifications(&api.base, &token);
    let rows = rows_of_type(&payload, "budget_over_limit");
    assert_eq!(
        rows.len(),
        1,
        "expected exactly one over-limit row: {payload}"
    );
    assert_eq!(rows[0]["referenceType"], "budget");
    assert_eq!(rows[0]["referenceId"], "budget-food");

    // A second push must dedupe against the same budget period.
    push(&api.base, &token, vec![op("budget-2", "budget", budget)]);
    let payload = notifications(&api.base, &token);
    assert_eq!(
        rows_of_type(&payload, "budget_over_limit").len(),
        1,
        "a duplicate period must not add a row: {payload}"
    );
}

// --- Budget period regression (Tier 2 review) ---

#[test]
fn expenses_outside_the_budget_period_do_not_count_toward_spend() {
    let db = temp_db("notif_budget_period");
    let api = boot(&db, 18160, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, user_id) = register(&api.base, "budget-period@example.com");

    let outside = (chrono::Utc::now() - chrono::Duration::days(60))
        .format("%Y-%m-%d")
        .to_string();
    push(
        &api.base,
        &token,
        vec![
            op(
                "period-budget",
                "budget",
                budget_record(&user_id, "budget-period-food", 10000),
            ),
            op(
                "period-expense-outside",
                "transaction",
                expense_record_on(&user_id, "expense-outside", 12000, &outside),
            ),
        ],
    );

    let payload = notifications(&api.base, &token);
    assert_eq!(
        rows_of_type(&payload, "budget_over_limit").len(),
        0,
        "an out-of-period expense must not produce a budget row: {payload}"
    );
    assert_eq!(
        rows_of_type(&payload, "budget_threshold").len(),
        0,
        "an out-of-period expense must not produce a budget row: {payload}"
    );

    // The same budget still alerts once the expense falls inside the period.
    push(
        &api.base,
        &token,
        vec![op(
            "period-expense-inside",
            "transaction",
            expense_record(&user_id, "expense-inside", 12000),
        )],
    );
    let payload = notifications(&api.base, &token);
    assert_eq!(
        rows_of_type(&payload, "budget_over_limit").len(),
        1,
        "an in-period expense must produce exactly one row: {payload}"
    );
}

// --- TR-14 ---

#[test]
fn a_due_recurring_rule_emits_a_bill_due_notification() {
    let db = temp_db("notif_bill");
    let api = boot(&db, 18156, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, user_id) = register(&api.base, "bill@example.com");

    let due = (chrono::Utc::now() + chrono::Duration::days(2))
        .format("%Y-%m-%d")
        .to_string();
    let rule = json!({
        "_id": "rule-rent",
        "userId": user_id,
        "accountId": "acc-checking",
        "categoryId": "cat-housing",
        "nextDueDate": due,
        "isActive": true,
        "isArchived": false,
        "title": "Rent",
        "amount": 150000,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });
    push(&api.base, &token, vec![op("rule-1", "recurringRule", rule)]);

    let payload = notifications(&api.base, &token);
    let rows = rows_of_type(&payload, "bill_due");
    assert_eq!(rows.len(), 1, "expected one bill_due row: {payload}");
    assert_eq!(rows[0]["referenceType"], "recurring_rule");
    assert_eq!(rows[0]["referenceId"], "rule-rent");
}

// --- TR-15 ---

#[test]
fn an_applied_push_emits_one_sync_completion_per_day_when_enabled() {
    let db = temp_db("notif_sync");
    let api = boot(&db, 18157, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, user_id) = register(&api.base, "sync@example.com");

    // Default is off: an applied push alone must not notify.
    push(
        &api.base,
        &token,
        vec![op(
            "sync-default",
            "account",
            account_record(&user_id, "acc-default", "Default"),
        )],
    );
    let payload = notifications(&api.base, &token);
    assert_eq!(
        rows_of_type(&payload, "sync_completed").len(),
        0,
        "sync notifications default to off: {payload}"
    );

    let (status, body) = patch(
        &api.base,
        &token,
        "/notifications/preferences",
        &json!({"syncNotificationsEnabled": true}),
    );
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["syncNotificationsEnabled"], true, "{body}");

    push(
        &api.base,
        &token,
        vec![op(
            "sync-1",
            "account",
            account_record(&user_id, "acc-one", "One"),
        )],
    );
    push(
        &api.base,
        &token,
        vec![op(
            "sync-2",
            "account",
            account_record(&user_id, "acc-two", "Two"),
        )],
    );

    let payload = notifications(&api.base, &token);
    assert_eq!(
        rows_of_type(&payload, "sync_completed").len(),
        1,
        "one row per day regardless of push count: {payload}"
    );
}

// --- TR-16 ---

#[test]
fn maintenance_due_events_use_the_same_pipeline() {
    let db = temp_db("notif_maintenance");
    let api = boot(&db, 18158, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, _user_id) = register(&api.base, "maintenance@example.com");

    let (status, body) = post(
        &api.base,
        &token,
        "/notifications/events",
        &json!({
            "type": "maintenance_due",
            "title": "HVAC filter",
            "message": "Replace the filter",
            "dedupeKey": "maint-1",
        }),
    );
    assert_eq!(status, StatusCode::OK, "{body}");

    let payload = notifications(&api.base, &token);
    let rows = rows_of_type(&payload, "maintenance_due");
    assert_eq!(rows.len(), 1, "{payload}");
    assert_eq!(rows[0]["title"], "HVAC filter");
}

// --- TR-17 ---

#[test]
fn account_deletion_removes_notification_rows() {
    let db = temp_db("notif_delete");
    let api = boot(&db, 18159, &[("NTFY_URL", ""), ("NTFY_TOPIC", "")]);
    let (token, user_id) = register(&api.base, "delete@example.com");

    let (status, body) = post(
        &api.base,
        &token,
        "/notifications/events",
        &json!({"type": "maintenance_due", "title": "Before delete", "dedupeKey": "del-1"}),
    );
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = delete(
        &api.base,
        &token,
        "/auth/account",
        &json!({"password": PASSWORD}),
    );
    assert_eq!(status, StatusCode::OK, "delete failed: {body}");

    drop(api);
    thread::sleep(Duration::from_millis(100));

    let conn = rusqlite::Connection::open(&db).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ?1",
            [&user_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0, "account deletion must remove notification rows");
}
