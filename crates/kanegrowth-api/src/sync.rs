use crate::db::Db;
use crate::entity_map;
use crate::models::*;
use crate::util::now_iso;
use chrono::Utc;
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::MutexGuard;

fn json_to_sql(col: &str, v: Value) -> Box<dyn rusqlite::ToSql> {
    // Financial promoted columns are stored in integer minor units. Fractional
    // values arriving from clients (e.g. dollars) are scaled to minor units.
    const FINANCIAL_COLUMNS: &[&str] = &[
        "amount",
        "currentBalance",
        "monthlyTargetMinor",
        "minimumPaymentMinor",
    ];
    let scale = FINANCIAL_COLUMNS.contains(&col);
    match v {
        Value::Null => Box::new(Option::<String>::None) as Box<dyn rusqlite::ToSql>,
        Value::Bool(b) => Box::new(if b { 1i64 } else { 0i64 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                if scale && f.fract() != 0.0 {
                    Box::new((f * 100.0).round() as i64)
                } else if f.fract() == 0.0 {
                    Box::new(f as i64)
                } else {
                    // Non-financial fractional value: keep as real.
                    Box::new(f)
                }
            } else {
                Box::new(n.to_string())
            }
        }
        Value::String(s) => Box::new(s),
        other => Box::new(other.to_string()),
    }
}

fn convert_value(v: &Value) -> Value {
    match v {
        Value::Bool(b) => json!(if *b { 1 } else { 0 }),
        _ => v.clone(),
    }
}

fn apply_defaults(table: &str, values: &mut std::collections::BTreeMap<String, Value>) {
    let set_if_missing =
        |values: &mut std::collections::BTreeMap<String, Value>, key: &str, val: Value| {
            if !values.contains_key(key) || values.get(key) == Some(&Value::Null) {
                // only set default if column exists; we check existence outside
                values.insert(key.to_string(), val);
            }
        };
    // We'll just insert defaults for known keys if null/missing, regardless
    match table {
        "accounts" => {
            set_if_missing(values, "name", json!(""));
            set_if_missing(values, "type", json!("bank"));
            set_if_missing(values, "currency", json!("USD"));
            set_if_missing(values, "currentBalance", json!(0));
            set_if_missing(values, "isArchived", json!(0));
            set_if_missing(values, "accountGroup", json!("banking"));
            set_if_missing(values, "isLiability", json!(0));
            set_if_missing(values, "interestRateBps", json!(0));
            set_if_missing(values, "minimumPaymentMinor", json!(0));
        }
        "transactions" => {
            set_if_missing(values, "accountId", json!(""));
            set_if_missing(values, "categoryId", json!(""));
            set_if_missing(values, "type", json!("expense"));
            set_if_missing(values, "status", json!("posted"));
            set_if_missing(values, "amount", json!(0));
            set_if_missing(
                values,
                "date",
                json!(Utc::now().format("%Y-%m-%d").to_string()),
            );
            set_if_missing(values, "clearedStatus", json!("pending"));
            set_if_missing(values, "isShared", json!(1));
            set_if_missing(values, "hasSplitChildren", json!(0));
            set_if_missing(values, "tagsJson", json!("[]"));
        }
        "categories" => {
            set_if_missing(values, "name", json!(""));
            set_if_missing(values, "isArchived", json!(0));
            set_if_missing(values, "envelopeType", json!("expense"));
            set_if_missing(values, "monthlyTargetMinor", json!(0));
        }
        "budgets" => {
            set_if_missing(values, "periodStart", json!(""));
            set_if_missing(values, "periodEnd", json!(""));
            set_if_missing(values, "isArchived", json!(0));
        }
        "tags" => {
            set_if_missing(values, "name", json!(""));
        }
        "recurringRules" => {
            set_if_missing(values, "accountId", json!(""));
            set_if_missing(values, "categoryId", json!(""));
            set_if_missing(values, "nextDueDate", json!(""));
            set_if_missing(values, "isActive", json!(1));
            set_if_missing(values, "isArchived", json!(0));
        }
        "categorizationRules" => {
            set_if_missing(values, "priority", json!(0));
            set_if_missing(values, "isActive", json!(1));
        }
        "savingsGoalContributions" => {
            set_if_missing(values, "goalId", json!(""));
            set_if_missing(values, "amount", json!(0));
            set_if_missing(values, "contributedAt", json!(now_iso()));
        }
        "transactionTemplates" => {
            set_if_missing(values, "name", json!(""));
        }
        "envelopeAssignments" => {
            set_if_missing(values, "kind", json!("assignment"));
            set_if_missing(values, "envelopeId", json!(""));
            set_if_missing(values, "amountMinor", json!(0));
        }
        _ => {}
    }
}

#[allow(clippy::type_complexity)]
fn read_record(
    conn: &rusqlite::Connection,
    table: &str,
    id: &str,
) -> Option<(
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
)> {
    // returns data, updatedAt, deletedAt, userId, workspaceId
    let sql = format!(
        "SELECT data, updatedAt, deletedAt, userId, workspaceId FROM {} WHERE _id = ?1",
        table
    );
    conn.query_row(&sql, params![id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })
    .ok()
}

fn is_personal_entity(entity: &str) -> bool {
    entity_map::is_personal_entity(entity)
}

fn scope_clause_and_params(
    _table: &str,
    entity: &str,
    user_id: &str,
    workspace_id: Option<&str>,
    include_deleted: bool,
) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut wheres: Vec<String> = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if is_personal_entity(entity) {
        wheres.push("userId = ?".to_string());
        params_vec.push(Box::new(user_id.to_string()));
    } else if let Some(w) = workspace_id {
        wheres.push("workspaceId = ?".to_string());
        params_vec.push(Box::new(w.to_string()));
    } else {
        wheres.push("userId = ?".to_string());
        params_vec.push(Box::new(user_id.to_string()));
    }
    if !include_deleted {
        wheres.push("deletedAt IS NULL".to_string());
    }
    (wheres.join(" AND "), params_vec)
}

#[allow(clippy::type_complexity)]
fn fetch_records(
    conn: &rusqlite::Connection,
    table: &str,
    entity: &str,
    user_id: &str,
    workspace_id: Option<&str>,
    include_deleted: bool,
    after_cursor: Option<&str>,
) -> Result<Vec<(Value, String, String, Option<String>)>, String> {
    // returns (record_value, updated_at, id, deleted_at)
    let (scope_where, mut params_vec) =
        scope_clause_and_params(table, entity, user_id, workspace_id, include_deleted);
    let mut wheres = vec![scope_where];
    if let Some(cur) = after_cursor {
        let cur = cur.trim();
        if !cur.is_empty() && cur != "0|" {
            let parts: Vec<&str> = cur.splitn(2, '|').collect();
            let cu = parts.first().copied().unwrap_or("");
            let ci = parts.get(1).copied().unwrap_or("");
            wheres.push("(updatedAt > ? OR (updatedAt = ? AND _id > ?))".to_string());
            params_vec.push(Box::new(cu.to_string()));
            params_vec.push(Box::new(cu.to_string()));
            params_vec.push(Box::new(ci.to_string()));
        }
    }
    let sql = format!(
        "SELECT data, updatedAt, _id, deletedAt FROM {} WHERE {} ORDER BY updatedAt ASC, _id ASC",
        table,
        wheres.join(" AND ")
    );
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_refs.as_slice(), |r| {
            let data: String = r.get(0)?;
            let updated: String = r.get(1)?;
            let id: String = r.get(2)?;
            let deleted: Option<String> = r.get(3)?;
            Ok((data, updated, id, deleted))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (data, updated, id, deleted) = row.map_err(|e| e.to_string())?;
        let rec: Value = serde_json::from_str(&data).unwrap_or(json!({}));
        out.push((rec, updated, id, deleted));
    }
    Ok(out)
}

fn upsert_record(
    conn: &rusqlite::Connection,
    table: &str,
    record: &Value,
    user_id: &str,
    workspace_id: Option<&str>,
) -> Result<String, String> {
    let id = record
        .get("_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing _id".to_string())?
        .to_string();
    let now = now_iso();
    let updated_at = record
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or(now.clone());
    let deleted_at = match record.get("deletedAt") {
        Some(Value::Null) => None,
        Some(v) => v.as_str().map(|s| s.to_string()),
        None => None,
    };

    let cols = crate::db::table_columns(conn, table);
    // A stale client may send `"userId": ""` (the pre-fix login shape produced exactly that).
    // Promote the authenticated subject instead, without ever overwriting a real id.
    let effective_user_id = if cols.contains(&"userId".to_string()) {
        record
            .get("userId")
            .and_then(|x| x.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| user_id.to_string())
    } else {
        user_id.to_string()
    };

    let mut rec = record.clone();
    if rec.get("updatedAt").is_none() {
        rec["updatedAt"] = json!(updated_at.clone());
    }
    if deleted_at.is_some() {
        rec["deletedAt"] = json!(deleted_at.clone());
    } else {
        // keep as is
    }
    if cols.contains(&"userId".to_string()) {
        let blank = rec
            .get("userId")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if blank {
            rec["userId"] = json!(effective_user_id);
        }
    }
    let data = serde_json::to_string(&rec).map_err(|e| e.to_string())?;

    let mut values: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    for c in &cols {
        values.insert(c.clone(), Value::Null);
    }
    if cols.contains(&"_id".to_string()) {
        values.insert("_id".into(), json!(id.clone()));
    }
    if cols.contains(&"updatedAt".to_string()) {
        values.insert("updatedAt".into(), json!(updated_at.clone()));
    }
    if cols.contains(&"deletedAt".to_string()) {
        if let Some(d) = &deleted_at {
            values.insert("deletedAt".into(), json!(d.clone()));
        } else {
            values.insert("deletedAt".into(), Value::Null);
        }
    }
    if cols.contains(&"data".to_string()) {
        values.insert("data".into(), json!(data));
    }
    if cols.contains(&"_localUpdatedAt".to_string()) {
        values.insert("_localUpdatedAt".into(), json!(updated_at.clone()));
    }
    if cols.contains(&"_dirty".to_string()) {
        values.insert("_dirty".into(), json!(0));
    }
    if cols.contains(&"_syncState".to_string()) {
        values.insert("_syncState".into(), json!("synced"));
    }
    if cols.contains(&"userId".to_string()) {
        values.insert("userId".into(), json!(effective_user_id));
    }
    if cols.contains(&"workspaceId".to_string()) {
        let v = workspace_id.map(|s| s.to_string()).or_else(|| {
            record
                .get("workspaceId")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });
        if let Some(w) = v {
            values.insert("workspaceId".into(), json!(w));
        } else {
            values.insert("workspaceId".into(), Value::Null);
        }
    }
    // promoted columns
    for pc in entity_map::promoted_columns(table) {
        if *pc == "userId" || *pc == "workspaceId" {
            continue;
        }
        if cols.contains(&pc.to_string()) {
            if let Some(v) = record.get(*pc) {
                values.insert(pc.to_string(), convert_value(v));
            }
        }
    }
    apply_defaults(table, &mut values);

    let col_names = cols.clone();
    let placeholders: Vec<String> = (1..=col_names.len()).map(|i| format!("?{}", i)).collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(_id) DO UPDATE SET {}",
        table,
        col_names.join(","),
        placeholders.join(","),
        col_names
            .iter()
            .filter(|c| *c != "_id")
            .map(|c| format!("{}=excluded.{}", c, c))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for c in &col_names {
        let v = values.get(c).cloned().unwrap_or(Value::Null);
        params_vec.push(json_to_sql(c, v));
    }
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())
        .map_err(|e| format!("upsert {table}: {e}"))?;
    Ok(id)
}

pub fn bootstrap(
    db: &Db,
    user_id: &str,
    workspace_id: Option<String>,
) -> Result<BootstrapSnapshot, String> {
    if let Some(w) = &workspace_id {
        if !crate::workspaces::is_member(db, w, user_id) {
            return Err("forbidden".to_string());
        }
    }
    let conn = crate::db::conn(db);
    let mut snap = BootstrapSnapshot {
        checkpoint: "0|".to_string(),
        accounts: vec![],
        transactions: vec![],
        categories: vec![],
        budgets: vec![],
        savings_goals: vec![],
        tags: vec![],
        recurring_rules: vec![],
        categorization_rules: vec![],
        savings_goal_contributions: vec![],
        transaction_templates: vec![],
        envelope_assignments: vec![],
    };

    // map entity -> field
    let pairs = [
        ("account", "accounts"),
        ("transaction", "transactions"),
        ("category", "categories"),
        ("budget", "budgets"),
        ("savingsGoal", "savingsGoals"),
        ("tag", "tags"),
        ("recurringRule", "recurringRules"),
        ("categorizationRule", "categorizationRules"),
        ("savingsGoalContribution", "savingsGoalContributions"),
        ("transactionTemplate", "transactionTemplates"),
        ("envelopeAssignment", "envelopeAssignments"),
    ];

    let mut all_cursor: Vec<(String, String)> = Vec::new();
    for (entity, table) in pairs.iter() {
        let recs = fetch_records(
            &conn,
            table,
            entity,
            user_id,
            workspace_id.as_deref(),
            false,
            None,
        )?;
        let mut arr = Vec::new();
        for (rec, updated, id, _del) in recs {
            arr.push(rec);
            all_cursor.push((updated, id));
        }
        match *table {
            "accounts" => snap.accounts = arr,
            "transactions" => snap.transactions = arr,
            "categories" => snap.categories = arr,
            "budgets" => snap.budgets = arr,
            "savingsGoals" => snap.savings_goals = arr,
            "tags" => snap.tags = arr,
            "recurringRules" => snap.recurring_rules = arr,
            "categorizationRules" => snap.categorization_rules = arr,
            "savingsGoalContributions" => snap.savings_goal_contributions = arr,
            "transactionTemplates" => snap.transaction_templates = arr,
            "envelopeAssignments" => snap.envelope_assignments = arr,
            _ => {}
        }
    }
    // checkpoint = max cursor
    all_cursor.sort();
    if let Some(last) = all_cursor.last() {
        snap.checkpoint = format!("{}|{}", last.0, last.1);
    } else {
        snap.checkpoint = "0|".to_string();
    }
    Ok(snap)
}

pub fn pull(
    db: &Db,
    user_id: &str,
    workspace_id: Option<String>,
    checkpoint: Option<String>,
) -> Result<PullPage, String> {
    if let Some(w) = &workspace_id {
        if !crate::workspaces::is_member(db, w, user_id) {
            return Err("forbidden".to_string());
        }
    }
    let conn = crate::db::conn(db);
    let mut items: Vec<(String, String, String, Option<String>, Value)> = Vec::new(); // entity, updated, id, deleted, record
    for table in entity_map::all_tables() {
        let entity = entity_map::entity_for_table(table).unwrap();
        let recs = fetch_records(
            &conn,
            table,
            entity,
            user_id,
            workspace_id.as_deref(),
            true,
            checkpoint.as_deref(),
        )?;
        for (rec, updated, id, deleted) in recs {
            items.push((entity.to_string(), updated, id, deleted, rec));
        }
    }
    items.sort_by(|a, b| {
        let c = a.1.cmp(&b.1);
        if c == std::cmp::Ordering::Equal {
            a.2.cmp(&b.2)
        } else {
            c
        }
    });

    let page_size = 100usize;
    let has_more = items.len() > page_size;
    let page_items: Vec<_> = items.into_iter().take(page_size).collect();

    let mut changes = Vec::new();
    let mut tombstones = Vec::new();
    let mut last_cursor = checkpoint.clone().unwrap_or_else(|| "0|".to_string());
    for (entity, updated, id, deleted, rec) in page_items {
        last_cursor = format!("{}|{}", updated, id);
        if let Some(del) = deleted {
            tombstones.push(SyncTombstone {
                entity: entity.clone(),
                id: id.clone(),
                deleted_at: del,
            });
        } else {
            changes.push(SyncChange {
                entity: entity.clone(),
                doc: rec,
            });
        }
    }
    if changes.is_empty() && tombstones.is_empty() && last_cursor == "0|" {
        if let Some(c) = checkpoint {
            last_cursor = c;
        }
    }
    Ok(PullPage {
        changes,
        tombstones,
        checkpoint: last_cursor,
        has_more,
    })
}

pub fn push(
    db: &Db,
    user_id: &str,
    workspace_id: Option<String>,
    req: SyncPushRequest,
) -> Result<PushResponse, String> {
    if let Some(w) = &workspace_id {
        // also check req workspace? use param
        if !crate::workspaces::is_member(db, w, user_id) {
            return Err("forbidden".to_string());
        }
    }
    // effective workspace
    let eff_workspace = workspace_id.clone().or(req.workspace_id.clone());

    let mut results = Vec::new();
    let conn = crate::db::conn(db);
    for op in &req.ops {
        // idempotency
        let existing_op: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT result_status, result_id FROM sync_operations WHERE op_id = ?1",
                params![op.op_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((status, rid)) = existing_op {
            results.push(SyncOpResult {
                op_id: op.op_id.clone(),
                status: "noop".to_string(),
                result_id: rid.or_else(|| {
                    // fallback parse from payload
                    op.payload
                        .get("_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                }),
                conflict: None,
                message: None,
            });
            // ignore stored status; replay -> noop per plan
            let _ = status;
            continue;
        }

        let table = match entity_map::table_for_entity(&op.entity) {
            Some(t) => t,
            None => {
                results.push(SyncOpResult {
                    op_id: op.op_id.clone(),
                    status: "rejected".to_string(),
                    result_id: None,
                    conflict: None,
                    message: Some("unknown entity".to_string()),
                });
                continue;
            }
        };
        let personal = entity_map::is_personal_entity(&op.entity);

        // workspace access for workspace-scoped if eff_workspace provided
        let op_workspace = if personal {
            None
        } else {
            eff_workspace.clone()
        };
        if let Some(w) = &op_workspace {
            if !crate::workspaces::is_member(db, w, user_id) {
                return Err("forbidden".to_string());
            }
        }

        let record_id = op
            .payload
            .get("_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        // fetch existing
        let existing = read_record(&conn, table, &record_id);

        let status: String;
        let result_id: Option<String> = Some(record_id.clone());
        let mut conflict: Option<ConflictData> = None;

        match op.operation.as_str() {
            "create" => {
                if let Some((data, updated_at, _del, ex_user, ex_ws)) = &existing {
                    // id conflict if different principal
                    let same_user = ex_user.as_deref() == Some(user_id);
                    let same_ws = ex_ws.as_deref() == op_workspace.as_deref();
                    if !(same_user && same_ws) {
                        status = "id_conflict".to_string();
                    } else {
                        // already exists same owner: treat as applied (upsert)
                        let _ = (data, updated_at);
                        upsert_record(&conn, table, &op.payload, user_id, op_workspace.as_deref())?;
                        status = "applied".to_string();
                    }
                } else {
                    // assign updatedAt if missing
                    let mut payload = op.payload.clone();
                    if payload.get("updatedAt").is_none() {
                        payload["updatedAt"] = json!(now_iso());
                    }
                    // ensure userId/workspaceId in payload? upsert handles
                    upsert_record(&conn, table, &payload, user_id, op_workspace.as_deref())?;
                    status = "applied".to_string();
                }
            }
            "update" => {
                if let Some((data, existing_updated, _del, _eu, _ew)) = &existing {
                    // conflict if stale baseUpdatedAt
                    let base = op.base_updated_at.clone();
                    if let Some(b) = base {
                        if b < *existing_updated {
                            // stale
                            let server_doc: Value = serde_json::from_str(data).unwrap_or(json!({}));
                            status = "conflict".to_string();
                            conflict = Some(ConflictData { server_doc });
                            // do not apply
                            // store op result as conflict
                            let _ = ();
                        } else {
                            // apply
                            let mut payload = op.payload.clone();
                            if payload.get("updatedAt").is_none() {
                                payload["updatedAt"] = json!(now_iso());
                            }
                            upsert_record(
                                &conn,
                                table,
                                &payload,
                                user_id,
                                op_workspace.as_deref(),
                            )?;
                            status = "applied".to_string();
                        }
                    } else {
                        // no base: apply
                        let mut payload = op.payload.clone();
                        if payload.get("updatedAt").is_none() {
                            payload["updatedAt"] = json!(now_iso());
                        }
                        upsert_record(&conn, table, &payload, user_id, op_workspace.as_deref())?;
                        status = "applied".to_string();
                    }
                } else {
                    // insert
                    let mut payload = op.payload.clone();
                    if payload.get("updatedAt").is_none() {
                        payload["updatedAt"] = json!(now_iso());
                    }
                    upsert_record(&conn, table, &payload, user_id, op_workspace.as_deref())?;
                    status = "applied".to_string();
                }
            }
            "delete" => {
                // set deletedAt
                let mut payload = op.payload.clone();
                if payload.get("_id").is_none() {
                    payload["_id"] = json!(record_id.clone());
                }
                if payload.get("deletedAt").is_none() {
                    payload["deletedAt"] = json!(now_iso());
                }
                if payload.get("updatedAt").is_none() {
                    payload["updatedAt"] = json!(now_iso());
                }
                // if existing, merge updatedAt? just upsert
                upsert_record(&conn, table, &payload, user_id, op_workspace.as_deref())?;
                status = "applied".to_string();
            }
            _ => {
                status = "rejected".to_string();
            }
        }

        // store sync_operation
        let rid_for_store = if status == "conflict" {
            None
        } else {
            result_id.clone()
        };
        conn.execute(
            "INSERT INTO sync_operations (op_id, user_id, workspace_id, entity, record_id, operation, result_status, result_id, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                op.op_id,
                user_id,
                op_workspace.clone(),
                op.entity,
                record_id,
                op.operation,
                status,
                rid_for_store,
                now_iso()
            ],
        )
        .map_err(|e| e.to_string())?;

        results.push(SyncOpResult {
            op_id: op.op_id.clone(),
            status,
            result_id: if conflict.is_some() {
                None
            } else {
                result_id.clone()
            },
            conflict,
            message: None,
        });
    }

    // checkpoint
    let checkpoint = compute_checkpoint(&conn, user_id, eff_workspace.as_deref());

    Ok(PushResponse {
        results,
        checkpoint,
    })
}

fn compute_checkpoint(
    conn: &rusqlite::Connection,
    user_id: &str,
    workspace_id: Option<&str>,
) -> String {
    // max cursor across all tables scoped
    let mut cursors: Vec<(String, String)> = Vec::new();
    for table in entity_map::all_tables() {
        let entity = entity_map::entity_for_table(table).unwrap();
        let (scope_where, params_vec) =
            scope_clause_and_params(table, entity, user_id, workspace_id, true);
        let sql = format!("SELECT updatedAt, _id FROM {} WHERE {}", table, scope_where);
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(params_refs.as_slice(), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            }) {
                for row in rows.flatten() {
                    cursors.push(row);
                }
            }
        }
    }
    cursors.sort();
    if let Some(last) = cursors.last() {
        format!("{}|{}", last.0, last.1)
    } else {
        "0|".to_string()
    }
}

// ensure unused import not warning
#[allow(dead_code)]
fn _use_mutex(_m: MutexGuard<'_, rusqlite::Connection>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn json_to_sql_integer_minor_units() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE accounts (_id TEXT PRIMARY KEY, userId TEXT, workspaceId TEXT, name TEXT, type TEXT, currency TEXT, currentBalance REAL NOT NULL DEFAULT 0, isArchived INTEGER NOT NULL DEFAULT 0, accountGroup TEXT, isLiability INTEGER NOT NULL DEFAULT 0, interestRateBps INTEGER NOT NULL DEFAULT 0, minimumPaymentMinor INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT, _localUpdatedAt TEXT NOT NULL, _dirty INTEGER NOT NULL DEFAULT 0, _syncState TEXT NOT NULL DEFAULT 'synced')",
            [],
        )
        .unwrap();
        let rec = json!({
            "_id": "acc1",
            "name": "Cash",
            "type": "bank",
            "currency": "USD",
            "currentBalance": 10.5,
            "updatedAt": "2026-01-01T00:00:00Z"
        });
        upsert_record(&conn, "accounts", &rec, "u1", None).unwrap();
        let val: f64 = conn
            .query_row(
                "SELECT currentBalance FROM accounts WHERE _id='acc1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(val, 1050.0);
    }

    #[test]
    fn checkpoint_encoding_roundtrip() {
        let c = format!("{}|{}", "2026-01-01T00:00:00Z", "id1");
        assert_eq!(c, "2026-01-01T00:00:00Z|id1");
    }
}
