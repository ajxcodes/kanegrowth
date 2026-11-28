//! Server-owned in-app notifications + ntfy delivery (issue #16).
//!
//! Rows are written first (so the bell always sees the event), then delivery runs in a detached
//! task. Producers are best-effort: every call site logs and continues, so a notifications bug can
//! never fail a sync push or a list request.

use crate::db::Db;
use crate::ntfy::NtfyClient;
use crate::util::now_iso;
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use uuid::Uuid;

/// Every notification type the server accepts. Anything else is a 400 at the event ingress.
pub const NOTIFICATION_TYPES: &[&str] = &[
    "budget_threshold",
    "budget_over_limit",
    "bill_due",
    "maintenance_due",
    "sync_completed",
    "import_completed",
    "savings_milestone",
    "workspace_invite",
];

pub const DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT: i64 = 80;
pub const DEFAULT_BILL_REMINDER_DAYS_BEFORE: i64 = 3;
pub const MIN_BUDGET_ALERT_THRESHOLD_PERCENT: i64 = 1;
pub const MAX_BUDGET_ALERT_THRESHOLD_PERCENT: i64 = 100;
pub const MIN_BILL_REMINDER_DAYS_BEFORE: i64 = 0;
pub const MAX_BILL_REMINDER_DAYS_BEFORE: i64 = 30;

const LIST_LIMIT: i64 = 100;
const MAX_NTFY_ERROR_CHARS: usize = 500;
/// Budget percentages are integer percent points; spend is compared as `spent * 100`.
const PERCENT_SCALE: i64 = 100;

// --- DTOs ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationDto {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub message: String,
    #[serde(rename = "referenceType", skip_serializing_if = "Option::is_none")]
    pub reference_type: Option<String>,
    #[serde(rename = "referenceId", skip_serializing_if = "Option::is_none")]
    pub reference_id: Option<String>,
    pub metadata: Value,
    #[serde(rename = "readAt")]
    pub read_at: Option<String>,
    #[serde(rename = "dismissedAt")]
    pub dismissed_at: Option<String>,
    #[serde(rename = "ntfyStatus")]
    pub ntfy_status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(rename = "ntfyError", skip_serializing_if = "Option::is_none")]
    pub ntfy_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationList {
    pub notifications: Vec<NotificationDto>,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
}

// --- Preferences ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub enabled: bool,
    pub budget_alerts_enabled: bool,
    pub budget_alert_threshold_percent: i64,
    pub bill_reminders_enabled: bool,
    pub bill_reminder_days_before: i64,
    pub maintenance_reminders_enabled: bool,
    pub sync_notifications_enabled: bool,
    pub savings_milestone_enabled: bool,
    pub workspace_invite_enabled: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            budget_alerts_enabled: true,
            budget_alert_threshold_percent: DEFAULT_BUDGET_ALERT_THRESHOLD_PERCENT,
            bill_reminders_enabled: true,
            bill_reminder_days_before: DEFAULT_BILL_REMINDER_DAYS_BEFORE,
            maintenance_reminders_enabled: true,
            sync_notifications_enabled: false,
            savings_milestone_enabled: true,
            workspace_invite_enabled: true,
        }
    }
}

/// All-optional PATCH body. Unknown keys are ignored (forward compatible) and absent keys keep
/// their stored value.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferencesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_alerts_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_alert_threshold_percent: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bill_reminders_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bill_reminder_days_before: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance_reminders_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_notifications_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub savings_milestone_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_invite_enabled: Option<bool>,
}

fn clamp_i64(value: i64, min: i64, max: i64) -> i64 {
    value.max(min).min(max)
}

fn read_bool(obj: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    obj.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn read_i64(obj: &Map<String, Value>, key: &str, fallback: i64) -> i64 {
    obj.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64)))
        .unwrap_or(fallback)
}

/// Normalises a stored `users.settings.notificationPreferences` value into a complete contract.
pub fn parse_preferences(raw: Option<&Value>) -> NotificationPreferences {
    let defaults = NotificationPreferences::default();
    let Some(obj) = raw.and_then(Value::as_object) else {
        return defaults;
    };
    NotificationPreferences {
        enabled: read_bool(obj, "enabled", defaults.enabled),
        budget_alerts_enabled: read_bool(
            obj,
            "budgetAlertsEnabled",
            defaults.budget_alerts_enabled,
        ),
        budget_alert_threshold_percent: clamp_i64(
            read_i64(
                obj,
                "budgetAlertThresholdPercent",
                defaults.budget_alert_threshold_percent,
            ),
            MIN_BUDGET_ALERT_THRESHOLD_PERCENT,
            MAX_BUDGET_ALERT_THRESHOLD_PERCENT,
        ),
        bill_reminders_enabled: read_bool(
            obj,
            "billRemindersEnabled",
            defaults.bill_reminders_enabled,
        ),
        bill_reminder_days_before: clamp_i64(
            read_i64(
                obj,
                "billReminderDaysBefore",
                defaults.bill_reminder_days_before,
            ),
            MIN_BILL_REMINDER_DAYS_BEFORE,
            MAX_BILL_REMINDER_DAYS_BEFORE,
        ),
        maintenance_reminders_enabled: read_bool(
            obj,
            "maintenanceRemindersEnabled",
            defaults.maintenance_reminders_enabled,
        ),
        sync_notifications_enabled: read_bool(
            obj,
            "syncNotificationsEnabled",
            defaults.sync_notifications_enabled,
        ),
        savings_milestone_enabled: read_bool(
            obj,
            "savingsMilestoneEnabled",
            defaults.savings_milestone_enabled,
        ),
        workspace_invite_enabled: read_bool(
            obj,
            "workspaceInviteEnabled",
            defaults.workspace_invite_enabled,
        ),
    }
}

/// Serialises the normalised contract as the JSON stored under `users.settings`.
pub fn preferences_value(raw: Option<&Value>) -> Value {
    serde_json::to_value(parse_preferences(raw)).unwrap_or_else(|_| json!({}))
}

/// Merges a partial preferences patch into the stored JSON object. Known keys are coerced and
/// clamped; unknown keys are preserved untouched for forward compatibility.
pub fn merge_preferences_json(current: Option<&Value>, patch: &Value) -> Value {
    let mut merged = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let Some(patch_obj) = patch.as_object() else {
        return Value::Object(merged);
    };

    let bool_keys = [
        "enabled",
        "budgetAlertsEnabled",
        "billRemindersEnabled",
        "maintenanceRemindersEnabled",
        "syncNotificationsEnabled",
        "savingsMilestoneEnabled",
        "workspaceInviteEnabled",
    ];
    for key in bool_keys {
        if let Some(value) = patch_obj.get(key).and_then(Value::as_bool) {
            merged.insert(key.to_string(), json!(value));
        }
    }
    if let Some(threshold) = patch_obj
        .get("budgetAlertThresholdPercent")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64)))
    {
        merged.insert(
            "budgetAlertThresholdPercent".to_string(),
            json!(clamp_i64(
                threshold,
                MIN_BUDGET_ALERT_THRESHOLD_PERCENT,
                MAX_BUDGET_ALERT_THRESHOLD_PERCENT
            )),
        );
    }
    if let Some(days) = patch_obj
        .get("billReminderDaysBefore")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64)))
    {
        merged.insert(
            "billReminderDaysBefore".to_string(),
            json!(clamp_i64(
                days,
                MIN_BILL_REMINDER_DAYS_BEFORE,
                MAX_BILL_REMINDER_DAYS_BEFORE
            )),
        );
    }

    Value::Object(merged)
}

fn stored_preferences(conn: &Connection, user_id: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT settings FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("notificationPreferences").cloned()))
}

pub fn get_preferences(db: &Db, user_id: &str) -> Result<NotificationPreferences, String> {
    let conn = crate::db::conn(db);
    let raw = stored_preferences(&conn, user_id)?;
    Ok(parse_preferences(raw.as_ref()))
}

pub fn update_preferences(
    db: &Db,
    user_id: &str,
    patch: NotificationPreferencesPatch,
) -> Result<NotificationPreferences, String> {
    let patch_value = serde_json::to_value(&patch).map_err(|e| e.to_string())?;
    let conn = crate::db::conn(db);
    let raw: String = conn
        .query_row(
            "SELECT settings FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut settings = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let merged = merge_preferences_json(settings.get("notificationPreferences"), &patch_value);
    settings.insert("notificationPreferences".to_string(), merged.clone());
    conn.execute(
        "UPDATE users SET settings = ?1, updated_at = ?2 WHERE id = ?3",
        params![Value::Object(settings).to_string(), now_iso(), user_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(parse_preferences(Some(&merged)))
}

fn type_enabled(prefs: &NotificationPreferences, kind: &str) -> bool {
    if !prefs.enabled {
        return false;
    }
    match kind {
        "budget_threshold" | "budget_over_limit" => prefs.budget_alerts_enabled,
        "bill_due" => prefs.bill_reminders_enabled,
        "maintenance_due" => prefs.maintenance_reminders_enabled,
        "sync_completed" => prefs.sync_notifications_enabled,
        "savings_milestone" => prefs.savings_milestone_enabled,
        "workspace_invite" => prefs.workspace_invite_enabled,
        // `import_completed` has no dedicated switch; the master switch covers it.
        _ => true,
    }
}

// --- Row helpers ---

fn row_to_dto(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotificationDto> {
    let metadata: String = row.get(5)?;
    Ok(NotificationDto {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        message: row.get(3)?,
        reference_type: row.get(4)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| json!({})),
        reference_id: row.get(6)?,
        read_at: row.get(7)?,
        dismissed_at: row.get(8)?,
        ntfy_status: row.get(9)?,
        ntfy_error: row.get(10)?,
        created_at: row.get(11)?,
        workspace_id: row.get(12)?,
    })
}

const SELECT_COLUMNS: &str = "id, type, title, message, reference_type, metadata, reference_id, \
     read_at, dismissed_at, ntfy_status, ntfy_error, created_at, workspace_id";

fn fetch_by_id(
    conn: &Connection,
    user_id: &str,
    id: &str,
) -> Result<Option<NotificationDto>, String> {
    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM notifications WHERE id = ?1 AND user_id = ?2"),
        params![id, user_id],
        row_to_dto,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn fetch_by_dedupe(
    conn: &Connection,
    user_id: &str,
    dedupe_key: &str,
) -> Result<Option<NotificationDto>, String> {
    conn.query_row(
        &format!(
            "SELECT {SELECT_COLUMNS} FROM notifications WHERE user_id = ?1 AND dedupe_key = ?2"
        ),
        params![user_id, dedupe_key],
        row_to_dto,
    )
    .optional()
    .map_err(|e| e.to_string())
}

// --- Emit ---

#[derive(Debug, Clone)]
pub struct NotificationEvent {
    pub kind: String,
    pub title: String,
    pub message: String,
    pub reference_type: Option<String>,
    pub reference_id: Option<String>,
    pub metadata: Value,
    pub dedupe_key: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmitOutcome {
    pub notification: Option<NotificationDto>,
    pub deduped: bool,
    pub suppressed: bool,
}

pub fn emit(
    db: &Db,
    ntfy: &NtfyClient,
    user_id: &str,
    event: NotificationEvent,
) -> Result<EmitOutcome, String> {
    let prefs = get_preferences(db, user_id)?;
    if !type_enabled(&prefs, &event.kind) {
        return Ok(EmitOutcome {
            notification: None,
            deduped: false,
            suppressed: true,
        });
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let ntfy_configured = ntfy.is_configured();
    let initial_status = if ntfy_configured {
        "pending"
    } else {
        "skipped"
    };
    let metadata = event.metadata.to_string();

    let (notification, deduped) = {
        let conn = crate::db::conn(db);
        let inserted = conn
            .execute(
                "INSERT INTO notifications \
                 (id, user_id, workspace_id, type, title, message, reference_type, reference_id, \
                  metadata, dedupe_key, read_at, dismissed_at, ntfy_status, ntfy_error, created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,NULL,?11,NULL,?12) \
                 ON CONFLICT(user_id, dedupe_key) DO NOTHING",
                params![
                    id,
                    user_id,
                    event.workspace_id,
                    event.kind,
                    event.title,
                    event.message,
                    event.reference_type,
                    event.reference_id,
                    metadata,
                    event.dedupe_key,
                    initial_status,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;

        if inserted == 0 {
            let existing = match event.dedupe_key.as_deref() {
                Some(key) => fetch_by_dedupe(&conn, user_id, key)?,
                None => None,
            };
            (existing, true)
        } else {
            (
                Some(NotificationDto {
                    id: id.clone(),
                    kind: event.kind.clone(),
                    title: event.title.clone(),
                    message: event.message.clone(),
                    reference_type: event.reference_type.clone(),
                    reference_id: event.reference_id.clone(),
                    metadata: event.metadata.clone(),
                    read_at: None,
                    dismissed_at: None,
                    ntfy_status: initial_status.to_string(),
                    ntfy_error: None,
                    created_at: now.clone(),
                    workspace_id: event.workspace_id.clone(),
                }),
                false,
            )
        }
    };

    if !deduped && ntfy_configured {
        spawn_delivery(
            db.clone(),
            ntfy.clone(),
            id,
            event.title.clone(),
            event.message.clone(),
        );
    }

    Ok(EmitOutcome {
        notification,
        deduped,
        suppressed: false,
    })
}

/// Fire-and-forget ntfy publish. The row already exists; only its status changes.
pub fn spawn_delivery(db: Db, ntfy: NtfyClient, id: String, title: String, message: String) {
    tokio::spawn(async move {
        let result = ntfy.publish(&title, &message, &[], "default").await;
        let conn = crate::db::conn(&db);
        match result {
            Ok(()) => {
                let _ = conn.execute(
                    "UPDATE notifications SET ntfy_status = 'sent', ntfy_error = NULL WHERE id = ?1",
                    params![id],
                );
            }
            Err(err) => {
                let truncated: String = err.chars().take(MAX_NTFY_ERROR_CHARS).collect();
                let _ = conn.execute(
                    "UPDATE notifications SET ntfy_status = 'failed', ntfy_error = ?1 WHERE id = ?2",
                    params![truncated, id],
                );
            }
        }
    });
}

// --- Owner-scoped CRUD ---

pub fn list(db: &Db, user_id: &str) -> Result<NotificationList, String> {
    let conn = crate::db::conn(db);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM notifications \
             WHERE user_id = ?1 AND dismissed_at IS NULL \
             ORDER BY created_at DESC, id DESC LIMIT ?2"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id, LIST_LIMIT], row_to_dto)
        .map_err(|e| e.to_string())?;
    let notifications = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let unread_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notifications \
             WHERE user_id = ?1 AND read_at IS NULL AND dismissed_at IS NULL",
            params![user_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(NotificationList {
        notifications,
        unread_count,
    })
}

pub fn mark_read(db: &Db, user_id: &str, id: &str) -> Result<NotificationDto, String> {
    let conn = crate::db::conn(db);
    conn.execute(
        "UPDATE notifications SET read_at = ?1 WHERE id = ?2 AND user_id = ?3 AND read_at IS NULL",
        params![now_iso(), id, user_id],
    )
    .map_err(|e| e.to_string())?;
    match fetch_by_id(&conn, user_id, id)? {
        Some(dto) => Ok(dto),
        None => Err("not found".to_string()),
    }
}

pub fn dismiss(db: &Db, user_id: &str, id: &str) -> Result<NotificationDto, String> {
    let conn = crate::db::conn(db);
    conn.execute(
        "UPDATE notifications SET dismissed_at = ?1 WHERE id = ?2 AND user_id = ?3 AND dismissed_at IS NULL",
        params![now_iso(), id, user_id],
    )
    .map_err(|e| e.to_string())?;
    match fetch_by_id(&conn, user_id, id)? {
        Some(dto) => Ok(dto),
        None => Err("not found".to_string()),
    }
}

pub fn mark_all_read(db: &Db, user_id: &str) -> Result<i64, String> {
    let conn = crate::db::conn(db);
    let updated = conn
        .execute(
            "UPDATE notifications SET read_at = ?1 \
             WHERE user_id = ?2 AND read_at IS NULL AND dismissed_at IS NULL",
            params![now_iso(), user_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(updated as i64)
}

// --- Producers ---

/// Parses a due date stored either as `YYYY-MM-DD` or as an RFC 3339 timestamp.
fn parse_due_date(value: &str) -> Option<NaiveDate> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date);
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.date_naive())
}

fn format_minor_units(minor: i64) -> String {
    format!("{:.2}", minor as f64 / 100.0)
}

fn data_amount(record: &Value) -> Option<i64> {
    record
        .get("amount")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64)))
}

/// Runs the due-date producers (bills + budgets). Best-effort: errors are logged, never returned.
pub fn run_due_checks(db: &Db, ntfy: &NtfyClient, user_id: &str) {
    if let Err(err) = emit_due_bills(db, ntfy, user_id) {
        tracing::warn!("bill notification evaluation failed: {err}");
    }
    if let Err(err) = emit_budget_alerts(db, ntfy, user_id) {
        tracing::warn!("budget notification evaluation failed: {err}");
    }
}

fn scope_filter() -> &'static str {
    "(userId = ?1 OR workspaceId IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1))"
}

struct BillCandidate {
    id: String,
    workspace_id: Option<String>,
    title: String,
    amount: i64,
    due_date: NaiveDate,
    raw_due: String,
}

fn emit_due_bills(db: &Db, ntfy: &NtfyClient, user_id: &str) -> Result<(), String> {
    let prefs = get_preferences(db, user_id)?;
    if !prefs.enabled || !prefs.bill_reminders_enabled {
        return Ok(());
    }
    let cutoff = Utc::now().date_naive() + chrono::Duration::days(prefs.bill_reminder_days_before);

    let candidates: Vec<BillCandidate> = {
        let conn = crate::db::conn(db);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT _id, workspaceId, nextDueDate, data FROM recurringRules \
                 WHERE deletedAt IS NULL AND isActive = 1 AND isArchived = 0 AND {}",
                scope_filter()
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        rows.filter_map(|row| row.ok())
            .filter_map(|(id, workspace_id, raw_due, data)| {
                let due_date = parse_due_date(&raw_due)?;
                let record: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
                Some(BillCandidate {
                    id,
                    workspace_id,
                    title: record
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Recurring bill")
                        .to_string(),
                    amount: data_amount(&record).unwrap_or(0),
                    due_date,
                    raw_due,
                })
            })
            .collect()
    };

    for bill in candidates {
        if bill.due_date > cutoff {
            continue;
        }
        let event = NotificationEvent {
            kind: "bill_due".to_string(),
            title: format!("Bill due: {}", bill.title),
            message: format!(
                "{} is due on {}. Amount: {}",
                bill.title,
                bill.due_date.format("%Y-%m-%d"),
                format_minor_units(bill.amount)
            ),
            reference_type: Some("recurring_rule".to_string()),
            reference_id: Some(bill.id.clone()),
            metadata: json!({ "dueDate": bill.raw_due }),
            dedupe_key: Some(format!("bill_due:{}:{}", bill.id, bill.raw_due)),
            workspace_id: bill.workspace_id,
        };
        if let Err(err) = emit(db, ntfy, user_id, event) {
            tracing::warn!("bill_due emit failed: {err}");
        }
    }
    Ok(())
}

struct BudgetCandidate {
    id: String,
    workspace_id: Option<String>,
    category_id: Option<String>,
    account_ids: Vec<String>,
    name: String,
    amount: i64,
    period_start: String,
    period_end: String,
}

struct ExpenseRow {
    id: String,
    workspace_id: Option<String>,
    category_id: String,
    account_id: String,
    amount: i64,
    date: String,
    split_transaction_id: Option<String>,
    has_split_children: bool,
}

/// Mirrors `computeBudgetSpentMinorPure` in `shared/src/budget.ts`: an expense only counts when it
/// falls inside the budget period, matches the budget's accounts, and obeys the shared split rule.
fn counts_toward_budget(
    budget: &BudgetCandidate,
    tx: &ExpenseRow,
    period_start: NaiveDate,
    period_end: NaiveDate,
    parent_ids: &HashSet<&str>,
) -> bool {
    // A budget only counts transactions in its own workspace scope (or personal).
    if budget.workspace_id.is_some() && tx.workspace_id.as_deref() != budget.workspace_id.as_deref()
    {
        return false;
    }
    if !budget.account_ids.is_empty() && !budget.account_ids.contains(&tx.account_id) {
        return false;
    }
    // `date` is stored either as `YYYY-MM-DD` or RFC 3339; an unparseable date cannot be placed
    // inside the period, so it never counts.
    let Some(date) = parse_due_date(&tx.date) else {
        return false;
    };
    if date < period_start || date > period_end {
        return false;
    }
    match &budget.category_id {
        // A split child counts in its own category; its parent is excluded once children exist.
        // The stored flag is the fast path and the child reference is the source of truth.
        Some(category_id) => {
            &tx.category_id == category_id
                && (tx.split_transaction_id.is_some()
                    || (!tx.has_split_children && !parent_ids.contains(tx.id.as_str())))
        }
        // Category-less budgets only count ordinary (non-split-child) transactions.
        None => tx.split_transaction_id.is_none(),
    }
}

fn emit_budget_alerts(db: &Db, ntfy: &NtfyClient, user_id: &str) -> Result<(), String> {
    let prefs = get_preferences(db, user_id)?;
    if !prefs.enabled || !prefs.budget_alerts_enabled {
        return Ok(());
    }
    let today = Utc::now().date_naive();

    let (budgets, expenses): (Vec<BudgetCandidate>, Vec<ExpenseRow>) = {
        let conn = crate::db::conn(db);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT _id, workspaceId, categoryId, periodStart, periodEnd, data FROM budgets \
                 WHERE deletedAt IS NULL AND isArchived = 0 AND {}",
                scope_filter()
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let budgets: Vec<BudgetCandidate> = rows
            .filter_map(|row| row.ok())
            .filter_map(
                |(id, workspace_id, category_id, period_start, period_end, data)| {
                    let record: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
                    let amount = data_amount(&record).unwrap_or(0);
                    if amount <= 0 {
                        return None;
                    }
                    let account_ids = record
                        .get("accountIds")
                        .and_then(Value::as_array)
                        .map(|ids| {
                            ids.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(BudgetCandidate {
                        id,
                        workspace_id,
                        category_id: category_id.filter(|c| !c.is_empty()),
                        account_ids,
                        name: record
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Budget")
                            .to_string(),
                        amount,
                        period_start,
                        period_end,
                    })
                },
            )
            .collect();

        let mut stmt = conn
            .prepare(&format!(
                "SELECT _id, workspaceId, categoryId, accountId, amount, date, \
                        splitTransactionId, hasSplitChildren FROM transactions \
                 WHERE deletedAt IS NULL AND type = 'expense' AND status = 'posted' \
                   AND amount > 0 AND {}",
                scope_filter()
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |r| {
                Ok(ExpenseRow {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    category_id: r.get(2)?,
                    account_id: r.get(3)?,
                    amount: r.get(4)?,
                    date: r.get(5)?,
                    split_transaction_id: r.get(6)?,
                    has_split_children: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let expenses = rows.filter_map(|row| row.ok()).collect::<Vec<_>>();
        (budgets, expenses)
    };

    let parent_ids: HashSet<&str> = expenses
        .iter()
        .filter_map(|tx| tx.split_transaction_id.as_deref())
        .collect();

    for budget in budgets {
        let Some(period_start) = parse_due_date(&budget.period_start) else {
            continue;
        };
        let Some(period_end) = parse_due_date(&budget.period_end) else {
            continue;
        };
        if today < period_start || today > period_end {
            continue;
        }

        let spent: i64 = expenses
            .iter()
            .filter(|tx| counts_toward_budget(&budget, tx, period_start, period_end, &parent_ids))
            .map(|tx| tx.amount)
            .sum();

        if spent <= 0 {
            continue;
        }
        let percent = (spent as f64 / budget.amount as f64 * PERCENT_SCALE as f64).round() as i64;
        let (kind, title) = if spent > budget.amount {
            (
                "budget_over_limit",
                format!("Budget exceeded: {}", budget.name),
            )
        } else if spent * PERCENT_SCALE >= budget.amount * prefs.budget_alert_threshold_percent {
            ("budget_threshold", format!("Budget alert: {}", budget.name))
        } else {
            continue;
        };

        let event = NotificationEvent {
            kind: kind.to_string(),
            title,
            message: format!(
                "{} is {}% used ({} of {} spent).",
                budget.name,
                percent,
                format_minor_units(spent),
                format_minor_units(budget.amount)
            ),
            reference_type: Some("budget".to_string()),
            reference_id: Some(budget.id.clone()),
            metadata: json!({ "spent": spent, "amount": budget.amount, "percent": percent }),
            dedupe_key: Some(format!("{}:{}:{}", kind, budget.id, budget.period_start)),
            workspace_id: budget.workspace_id,
        };
        if let Err(err) = emit(db, ntfy, user_id, event) {
            tracing::warn!("{kind} emit failed: {err}");
        }
    }
    Ok(())
}

pub fn emit_sync_completed(
    db: &Db,
    ntfy: &NtfyClient,
    user_id: &str,
    workspace_id: Option<&str>,
    applied: usize,
) {
    if applied == 0 {
        return;
    }
    let prefs = match get_preferences(db, user_id) {
        Ok(prefs) => prefs,
        Err(err) => {
            tracing::warn!("sync_completed preferences read failed: {err}");
            return;
        }
    };
    if !prefs.enabled || !prefs.sync_notifications_enabled {
        return;
    }
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let event = NotificationEvent {
        kind: "sync_completed".to_string(),
        title: "Sync complete".to_string(),
        message: format!("{applied} change(s) synced"),
        reference_type: Some("sync".to_string()),
        reference_id: None,
        metadata: json!({ "applied": applied }),
        dedupe_key: Some(format!("sync_completed:{today}")),
        workspace_id: workspace_id.map(str::to_string),
    };
    if let Err(err) = emit(db, ntfy, user_id, event) {
        tracing::warn!("sync_completed emit failed: {err}");
    }
}

// --- Test helper ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_default_to_a_complete_contract_with_sync_off() {
        let prefs = parse_preferences(None);
        assert!(prefs.enabled);
        assert!(prefs.budget_alerts_enabled);
        assert_eq!(prefs.budget_alert_threshold_percent, 80);
        assert!(prefs.bill_reminders_enabled);
        assert_eq!(prefs.bill_reminder_days_before, 3);
        assert!(prefs.maintenance_reminders_enabled);
        assert!(!prefs.sync_notifications_enabled);
        assert!(prefs.savings_milestone_enabled);
        assert!(prefs.workspace_invite_enabled);
    }

    #[test]
    fn preferences_are_clamped() {
        let raw = json!({
            "budgetAlertThresholdPercent": 500,
            "billReminderDaysBefore": 90,
        });
        let prefs = parse_preferences(Some(&raw));
        assert_eq!(prefs.budget_alert_threshold_percent, 100);
        assert_eq!(prefs.bill_reminder_days_before, 30);

        let raw = json!({
            "budgetAlertThresholdPercent": 0,
            "billReminderDaysBefore": -4,
        });
        let prefs = parse_preferences(Some(&raw));
        assert_eq!(prefs.budget_alert_threshold_percent, 1);
        assert_eq!(prefs.bill_reminder_days_before, 0);
    }

    #[test]
    fn merge_preserves_unknown_keys_and_applies_known_ones() {
        let current = json!({
            "billRemindersEnabled": true,
            "futureKey": { "nested": true },
        });
        let patch = json!({ "billRemindersEnabled": false, "budgetAlertThresholdPercent": 50 });
        let merged = merge_preferences_json(Some(&current), &patch);
        let obj = merged.as_object().unwrap();
        assert_eq!(obj.get("billRemindersEnabled"), Some(&json!(false)));
        assert_eq!(obj.get("budgetAlertThresholdPercent"), Some(&json!(50)));
        assert_eq!(obj.get("futureKey"), Some(&json!({ "nested": true })));
    }

    #[test]
    fn merge_ignores_unknown_and_invalid_types() {
        let current = json!({ "billReminderDaysBefore": 3 });
        let patch = json!({ "billReminderDaysBefore": "soon", "unknownKey": 1 });
        let merged = merge_preferences_json(Some(&current), &patch);
        let obj = merged.as_object().unwrap();
        assert_eq!(obj.get("billReminderDaysBefore"), Some(&json!(3)));
        // Known-key merging never introduces a key the patch did not supply validly.
        assert!(!obj.contains_key("unknownKey"));
    }

    #[test]
    fn type_gate_respects_master_and_per_type_switches() {
        let mut prefs = NotificationPreferences::default();
        assert!(type_enabled(&prefs, "bill_due"));
        assert!(!type_enabled(&prefs, "sync_completed"));
        prefs.sync_notifications_enabled = true;
        assert!(type_enabled(&prefs, "sync_completed"));
        prefs.enabled = false;
        assert!(!type_enabled(&prefs, "sync_completed"));
        assert!(!type_enabled(&prefs, "bill_due"));
    }

    fn test_budget(category_id: Option<&str>) -> BudgetCandidate {
        BudgetCandidate {
            id: "budget-1".to_string(),
            workspace_id: None,
            category_id: category_id.map(str::to_string),
            account_ids: Vec::new(),
            name: "Food".to_string(),
            amount: 10_000,
            period_start: "2026-11-01".to_string(),
            period_end: "2026-11-30".to_string(),
        }
    }

    fn test_expense(
        id: &str,
        category_id: &str,
        has_split_children: bool,
        split_transaction_id: Option<&str>,
    ) -> ExpenseRow {
        ExpenseRow {
            id: id.to_string(),
            workspace_id: None,
            category_id: category_id.to_string(),
            account_id: "acc-checking".to_string(),
            amount: 1_000,
            date: "2026-11-15".to_string(),
            split_transaction_id: split_transaction_id.map(str::to_string),
            has_split_children,
        }
    }

    #[test]
    fn budget_spend_ignores_transactions_outside_the_period() {
        let budget = test_budget(Some("cat-food"));
        let start = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 11, 30).unwrap();
        let parents = HashSet::new();

        let inside = test_expense("inside", "cat-food", false, None);
        assert!(counts_toward_budget(&budget, &inside, start, end, &parents));

        let mut before = test_expense("before", "cat-food", false, None);
        before.date = "2026-09-15".to_string();
        assert!(!counts_toward_budget(
            &budget, &before, start, end, &parents
        ));

        let mut after = test_expense("after", "cat-food", false, None);
        after.date = "2026-12-01".to_string();
        assert!(!counts_toward_budget(&budget, &after, start, end, &parents));
    }

    #[test]
    fn budget_spend_mirrors_the_shared_split_rule() {
        let start = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 11, 30).unwrap();
        let parent = test_expense("parent", "cat-food", true, None);
        let child = test_expense("child", "cat-food", false, Some("parent"));
        let parent_ids: HashSet<&str> = [&parent, &child]
            .into_iter()
            .filter_map(|tx| tx.split_transaction_id.as_deref())
            .collect();

        // A category budget counts the split child in its category and drops the parent.
        let category_budget = test_budget(Some("cat-food"));
        assert!(!counts_toward_budget(
            &category_budget,
            &parent,
            start,
            end,
            &parent_ids
        ));
        assert!(counts_toward_budget(
            &category_budget,
            &child,
            start,
            end,
            &parent_ids
        ));

        // A category-less budget drops split children but still counts the parent row.
        let all_budget = test_budget(None);
        assert!(counts_toward_budget(
            &all_budget,
            &parent,
            start,
            end,
            &parent_ids
        ));
        assert!(!counts_toward_budget(
            &all_budget,
            &child,
            start,
            end,
            &parent_ids
        ));
    }

    #[test]
    fn due_dates_accept_both_stored_shapes() {
        assert_eq!(
            parse_due_date("2026-11-30"),
            NaiveDate::from_ymd_opt(2026, 11, 30)
        );
        assert_eq!(
            parse_due_date("2026-11-30T00:00:00.000Z"),
            NaiveDate::from_ymd_opt(2026, 11, 30)
        );
        assert_eq!(parse_due_date(""), None);
    }
}
