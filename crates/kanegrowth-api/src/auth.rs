use crate::config::Config;
use crate::db::Db;
use crate::models::{
    AccountDeletionImpact, AffectedWorkspace, AuthData, LegalVersions, UpdateUserRequest, UserDto,
    LEGAL_PRIVACY_VERSION, LEGAL_TERMS_VERSION,
};
use crate::util::now_iso;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::rngs::OsRng;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PASSWORD_RESET_TOKENS: &str = "password_reset_tokens";
const EMAIL_VERIFICATION_TOKENS: &str = "email_verification_tokens";

const PASSWORD_RESET_TTL_SECS: i64 = 30 * 60;
const EMAIL_VERIFICATION_TTL_SECS: i64 = 24 * 60 * 60;
const MIN_PASSWORD_LEN: usize = 12;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub email: String,
    pub exp: usize,
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub fn create_access_token(config: &Config, user_id: &str, email: &str) -> Result<String, String> {
    let exp = (Utc::now() + Duration::seconds(config.access_ttl_secs)).timestamp() as usize;
    let claims = Claims {
        sub: user_id.to_string(),
        email: email.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

pub fn validate_access_token(config: &Config, token: &str) -> Result<Claims, String> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| e.to_string())?;
    Ok(data.claims)
}

pub fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn new_refresh_token() -> String {
    Uuid::new_v4().to_string() + &Uuid::new_v4().to_string().replace('-', "")
}

fn new_raw_token() -> String {
    Uuid::new_v4().to_string().replace('-', "") + &Uuid::new_v4().to_string().replace('-', "")
}

fn settings_object(settings_json: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(settings_json)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn user_to_dto(
    id: String,
    email: String,
    full_name: Option<String>,
    email_verified: i64,
    created_at: String,
    settings_json: &str,
) -> UserDto {
    let settings = settings_object(settings_json);
    UserDto {
        id,
        email,
        full_name: full_name.unwrap_or_default(),
        email_verified: email_verified != 0,
        created_at,
        timezone: settings
            .get("timezone")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        preferred_currency: settings
            .get("preferredCurrency")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        date_format: settings
            .get("dateFormat")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        page_size: settings.get("pageSize").and_then(|v| v.as_i64()),
        notification_preferences: Some(crate::notifications::preferences_value(
            settings.get("notificationPreferences"),
        )),
        legal_acceptance: settings.get("legalAcceptance").cloned(),
        legal_versions: LegalVersions::current(),
    }
}

pub fn register_user(
    db: &Db,
    config: &Config,
    req: &crate::models::RegisterRequest,
) -> Result<AuthData, String> {
    let email = req.email.as_str();
    let password = req.password.as_str();
    let full_name = req.full_name.clone();
    let timezone = req.timezone.clone();
    let accepted_terms = req.accepted_terms;
    let age_attested = req.age_attested;
    let conn = crate::db::conn(db);
    // check existing
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM users WHERE email = ?1",
            params![email],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        return Err("email already registered".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let hash = hash_password(password)?;
    let now = now_iso();

    let mut settings = Map::new();
    if let Some(tz) = timezone.filter(|t| !t.trim().is_empty()) {
        settings.insert("timezone".to_string(), json!(tz));
    }
    if accepted_terms.unwrap_or(false) {
        settings.insert(
            "legalAcceptance".to_string(),
            json!({
                "termsVersion": LEGAL_TERMS_VERSION,
                "privacyVersion": LEGAL_PRIVACY_VERSION,
                "acceptedAt": now,
                "ageAttested": age_attested.unwrap_or(false),
            }),
        );
    }
    let settings_json = Value::Object(settings).to_string();
    let verified = if config.require_email_verification {
        0
    } else {
        1
    };

    conn.execute(
        "INSERT INTO users (id, email, password_hash, full_name, email_verified, created_at, updated_at, settings) VALUES (?1,?2,?3,?4,?5,?6,?6,?7)",
        params![id, email, hash, full_name, verified, now, settings_json],
    )
    .map_err(|e| e.to_string())?;

    // default personal workspace
    let ws_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)",
        params![ws_id, "Personal", id, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1,?2,'owner',?3)",
        params![ws_id, id, now],
    )
    .map_err(|e| e.to_string())?;

    drop(conn);
    issue_tokens(db, config, &id)
}

/// Issues an access/refresh pair plus the canonical user DTO for `user_id`.
///
/// The user row is read *before* the refresh-token write, so no `conn` guard is alive while any
/// other helper that locks the same `Db` runs (the mutex is not re-entrant).
pub fn issue_tokens(db: &Db, config: &Config, user_id: &str) -> Result<AuthData, String> {
    let user = get_user(db, user_id)?;
    let access = create_access_token(config, &user.id, &user.email)?;
    let refresh = new_refresh_token();
    let refresh_hash = hash_refresh_token(&refresh);
    let conn = crate::db::conn(db);
    let now = now_iso();
    let expires = (Utc::now() + Duration::days(config.refresh_ttl_days)).to_rfc3339();
    let rid = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, created_at) VALUES (?1,?2,?3,?4,0,?5)",
        params![rid, user_id, refresh_hash, expires, now],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    // Offline session grant (issue #18). Fail-open for online auth: a missing or malformed signing
    // key leaves `offlineGrant` absent instead of failing the login; the client then fails closed
    // on offline restore, exactly as before this change.
    let offline_grant = match crate::offline_grant::issue(config, &user.id) {
        Ok(grant) => Some(grant),
        Err(err) => {
            if config.offline_grant_private_key.is_some() {
                tracing::error!("offline grant signing failed: {err}");
            }
            None
        }
    };

    Ok(AuthData {
        token: access,
        refresh_token: refresh,
        offline_grant,
        user,
    })
}

pub fn login_user(
    db: &Db,
    config: &Config,
    email: &str,
    password: &str,
) -> Result<AuthData, String> {
    let conn = crate::db::conn(db);
    let row: Result<(String, String, i64), _> = conn.query_row(
        "SELECT id, password_hash, email_verified FROM users WHERE email = ?1",
        params![email],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    let (id, hash, ev) = row.map_err(|_| "invalid credentials".to_string())?;
    if !verify_password(password, &hash) {
        return Err("invalid credentials".to_string());
    }
    drop(conn);
    if config.require_email_verification && ev == 0 {
        return Err("email not verified".to_string());
    }
    issue_tokens(db, config, &id)
}

pub fn refresh_access(db: &Db, config: &Config, refresh_token: &str) -> Result<AuthData, String> {
    let hash = hash_refresh_token(refresh_token);
    let conn = crate::db::conn(db);
    let row: Result<(String, String, i64, String), _> = conn.query_row(
        "SELECT rt.id, rt.user_id, rt.revoked, rt.expires_at FROM refresh_tokens rt WHERE rt.token_hash = ?1",
        params![hash],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    );
    let (rid, user_id, revoked, expires_at) =
        row.map_err(|_| "invalid refresh token".to_string())?;
    if revoked != 0 {
        return Err("revoked".to_string());
    }
    // check expiry
    if expires_at < now_iso() {
        return Err("expired".to_string());
    }
    // revoke old
    conn.execute(
        "UPDATE refresh_tokens SET revoked = 1 WHERE id = ?1",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    issue_tokens(db, config, &user_id)
}

pub fn revoke_refresh(db: &Db, refresh_token: &str) -> Result<(), String> {
    let hash = hash_refresh_token(refresh_token);
    let conn = crate::db::conn(db);
    conn.execute(
        "UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?1",
        params![hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn revoke_all(db: &Db, user_id: &str) -> Result<(), String> {
    let conn = crate::db::conn(db);
    conn.execute(
        "UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_user(db: &Db, user_id: &str) -> Result<UserDto, String> {
    let conn = crate::db::conn(db);
    let row: (String, Option<String>, i64, String, String) = conn
        .query_row(
            "SELECT email, full_name, email_verified, created_at, settings FROM users WHERE id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(user_to_dto(
        user_id.to_string(),
        row.0,
        row.1,
        row.2,
        row.3,
        &row.4,
    ))
}

pub fn backfill_email_verified(db: &Db) -> Result<(), String> {
    let conn = crate::db::conn(db);
    conn.execute(
        "UPDATE users SET email_verified = 1 WHERE email_verified = 0",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn patch_user(db: &Db, user_id: &str, req: UpdateUserRequest) -> Result<UserDto, String> {
    if let Some(name) = &req.full_name {
        if name.trim().is_empty() {
            return Err("full name cannot be empty".to_string());
        }
    }

    let conn = crate::db::conn(db);
    let raw: String = conn
        .query_row(
            "SELECT settings FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut settings = settings_object(&raw);

    if let Some(name) = &req.full_name {
        conn.execute(
            "UPDATE users SET full_name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name.trim(), now_iso(), user_id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(tz) = &req.timezone {
        settings.insert("timezone".to_string(), json!(tz));
    }
    if let Some(currency) = &req.preferred_currency {
        settings.insert("preferredCurrency".to_string(), json!(currency));
    }
    if let Some(date_format) = &req.date_format {
        settings.insert("dateFormat".to_string(), json!(date_format));
    }
    if let Some(page_size) = req.page_size {
        settings.insert("pageSize".to_string(), json!(page_size));
    }
    if let Some(prefs) = &req.notification_preferences {
        // Merge known keys so a partial update from an older client cannot erase budget/sync keys.
        settings.insert(
            "notificationPreferences".to_string(),
            crate::notifications::merge_preferences_json(
                settings.get("notificationPreferences"),
                prefs,
            ),
        );
    }

    conn.execute(
        "UPDATE users SET settings = ?1, updated_at = ?2 WHERE id = ?3",
        params![Value::Object(settings).to_string(), now_iso(), user_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    get_user(db, user_id)
}

// --- single-use email/password tokens ---

fn create_token(
    conn: &Connection,
    table: &str,
    user_id: &str,
    ttl_secs: i64,
) -> Result<String, String> {
    debug_assert!(table == PASSWORD_RESET_TOKENS || table == EMAIL_VERIFICATION_TOKENS);
    let token = new_raw_token();
    let hash = hash_refresh_token(&token);
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let expires = (Utc::now() + Duration::seconds(ttl_secs)).to_rfc3339();
    conn.execute(
        &format!(
            "INSERT INTO {table} (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?1,?2,?3,?4,NULL,?5)"
        ),
        params![id, user_id, hash, expires, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(token)
}

fn consume_token(conn: &Connection, table: &str, token: &str) -> Result<String, String> {
    debug_assert!(table == PASSWORD_RESET_TOKENS || table == EMAIL_VERIFICATION_TOKENS);
    let hash = hash_refresh_token(token);
    let row: Result<(String, String, Option<String>, String), _> = conn.query_row(
        &format!("SELECT id, user_id, used_at, expires_at FROM {table} WHERE token_hash = ?1"),
        params![hash],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    );
    let (id, user_id, used_at, expires_at) =
        row.map_err(|_| "invalid or expired token".to_string())?;
    if used_at.is_some() {
        return Err("token already used".to_string());
    }
    if expires_at < now_iso() {
        return Err("token expired".to_string());
    }
    conn.execute(
        &format!("UPDATE {table} SET used_at = ?1 WHERE id = ?2"),
        params![now_iso(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(user_id)
}

pub fn create_password_reset(db: &Db, email: &str) -> Result<Option<String>, String> {
    let conn = crate::db::conn(db);
    let user: Option<String> = conn
        .query_row(
            "SELECT id FROM users WHERE email = ?1",
            params![email],
            |r| r.get(0),
        )
        .ok();
    let token = match user {
        Some(user_id) => Some(create_token(
            &conn,
            PASSWORD_RESET_TOKENS,
            &user_id,
            PASSWORD_RESET_TTL_SECS,
        )?),
        None => None,
    };
    drop(conn);
    if let Some(token) = &token {
        tracing::info!("password reset link: /reset-password?token={token}");
    }
    Ok(token)
}

pub fn reset_password(db: &Db, token: &str, password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!(
            "password must be at least {MIN_PASSWORD_LEN} characters"
        ));
    }
    let hash = hash_password(password)?;
    let conn = crate::db::conn(db);
    let user_id = consume_token(&conn, PASSWORD_RESET_TOKENS, token)?;
    conn.execute(
        "UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
        params![hash, now_iso(), user_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    revoke_all(db, &user_id)
}

pub fn create_email_verification(db: &Db, user_id: &str) -> Result<String, String> {
    let conn = crate::db::conn(db);
    let token = create_token(
        &conn,
        EMAIL_VERIFICATION_TOKENS,
        user_id,
        EMAIL_VERIFICATION_TTL_SECS,
    )?;
    drop(conn);
    tracing::info!("email verification link: /verify-email?token={token}");
    Ok(token)
}

/// Signed-out resend path: resolves the account from the address and issues a token when one
/// exists. Unknown addresses are not an error, so callers cannot enumerate accounts.
pub fn create_email_verification_by_email(db: &Db, email: &str) -> Result<Option<String>, String> {
    let user_id: Option<String> = {
        let conn = crate::db::conn(db);
        conn.query_row(
            "SELECT id FROM users WHERE email = ?1",
            params![email],
            |r| r.get(0),
        )
        .ok()
    };
    match user_id {
        Some(user_id) => create_email_verification(db, &user_id).map(Some),
        None => Ok(None),
    }
}

pub fn confirm_email(db: &Db, token: &str) -> Result<(), String> {
    let conn = crate::db::conn(db);
    let user_id = consume_token(&conn, EMAIL_VERIFICATION_TOKENS, token)?;
    conn.execute(
        "UPDATE users SET email_verified = 1, updated_at = ?1 WHERE id = ?2",
        params![now_iso(), user_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn accept_legal(db: &Db, user_id: &str, age_attested: bool) -> Result<UserDto, String> {
    let conn = crate::db::conn(db);
    let raw: String = conn
        .query_row(
            "SELECT settings FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut settings = settings_object(&raw);
    settings.insert(
        "legalAcceptance".to_string(),
        json!({
            "termsVersion": LEGAL_TERMS_VERSION,
            "privacyVersion": LEGAL_PRIVACY_VERSION,
            "acceptedAt": now_iso(),
            "ageAttested": age_attested,
        }),
    );
    conn.execute(
        "UPDATE users SET settings = ?1, updated_at = ?2 WHERE id = ?3",
        params![Value::Object(settings).to_string(), now_iso(), user_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    get_user(db, user_id)
}

/// Authored rows that survive an account deletion because they live in a workspace with another
/// member. Only tables that actually carry both `userId` and `workspaceId` are considered.
pub fn deletion_impact(db: &Db, user_id: &str) -> Result<AccountDeletionImpact, String> {
    let conn = crate::db::conn(db);
    let shared: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT w.id, w.name FROM workspaces w \
                 WHERE (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) > 1 \
                 AND EXISTS (SELECT 1 FROM workspace_members m2 WHERE m2.workspace_id = w.id AND m2.user_id = ?1)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut retained = 0i64;
    let mut affected: Vec<AffectedWorkspace> = Vec::new();
    for table in crate::entity_map::all_tables() {
        let cols = crate::db::table_columns(&conn, table);
        if !cols.iter().any(|c| c == "userId") || !cols.iter().any(|c| c == "workspaceId") {
            continue;
        }
        let live_filter = if cols.iter().any(|c| c == "deletedAt") {
            " AND deletedAt IS NULL"
        } else {
            ""
        };
        for (workspace_id, name) in &shared {
            let count: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} WHERE userId = ?1 AND workspaceId = ?2{live_filter}"
                    ),
                    params![user_id, workspace_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if count > 0 {
                retained += count;
                if !affected.iter().any(|w| &w.workspace_id == workspace_id) {
                    affected.push(AffectedWorkspace {
                        workspace_id: workspace_id.clone(),
                        name: name.clone(),
                    });
                }
            }
        }
    }

    Ok(AccountDeletionImpact {
        retained_record_count: retained,
        affected_workspaces: affected,
    })
}

pub fn delete_account(db: &Db, user_id: &str, password: &str) -> Result<(), String> {
    let hash: String = {
        let conn = crate::db::conn(db);
        conn.query_row(
            "SELECT password_hash FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .map_err(|_| "invalid password".to_string())?
    };
    if !verify_password(password, &hash) {
        return Err("invalid password".to_string());
    }

    let conn = crate::db::conn(db);
    let now = now_iso();

    // 1. Transfer ownership of shared workspaces the caller owns to a remaining member.
    let owned_shared: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT w.id FROM workspaces w WHERE w.owner_user_id = ?1 \
                 AND (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) > 1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for workspace_id in owned_shared {
        let next_owner: String = conn
            .query_row(
                "SELECT user_id FROM workspace_members WHERE workspace_id = ?1 AND user_id <> ?2 \
                 ORDER BY created_at ASC, user_id ASC LIMIT 1",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE workspaces SET owner_user_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![next_owner, now, workspace_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 2. Reassign authored rows in shared workspaces to their (possibly new) owner, then delete
    //    everything else the caller authored.
    for table in crate::entity_map::all_tables() {
        let cols = crate::db::table_columns(&conn, table);
        if !cols.iter().any(|c| c == "userId") || !cols.iter().any(|c| c == "workspaceId") {
            continue;
        }
        conn.execute(
            &format!(
                "UPDATE {table} SET userId = (SELECT owner_user_id FROM workspaces WHERE workspaces.id = {table}.workspaceId) \
                 WHERE userId = ?1 AND workspaceId IN (SELECT workspace_id FROM workspace_members WHERE user_id <> ?1)"
            ),
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for table in crate::entity_map::all_tables() {
        let cols = crate::db::table_columns(&conn, table);
        if !cols.iter().any(|c| c == "userId") {
            continue;
        }
        conn.execute(
            &format!("DELETE FROM {table} WHERE userId = ?1"),
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 3. Remove membership rows, then owned workspaces with no surviving member.
    conn.execute(
        "DELETE FROM workspace_members WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM workspaces WHERE owner_user_id = ?1 \
         AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = workspaces.id)",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;

    // 4. Tokens and sync metadata, then the user row itself.
    conn.execute(
        "DELETE FROM refresh_tokens WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM password_reset_tokens WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM email_verification_tokens WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM sync_operations WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    // `notifications` is server-owned (not in `entity_map::all_tables`), so the generic loops above
    // never touch it. Delete explicitly before the `users` row to satisfy the foreign key.
    conn.execute(
        "DELETE FROM notifications WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM users WHERE id = ?1", params![user_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn test_db(name: &str) -> (Db, String) {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "kg_auth_unit_{}_{}_{}.db",
            name,
            std::process::id(),
            Uuid::new_v4()
        ));
        let path = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);
        let db = db::open_db(&path).expect("open db");
        (db, path)
    }

    fn insert_user(conn: &Connection, id: &str, email: &str, verified: i64) {
        let now = now_iso();
        conn.execute(
            "INSERT INTO users (id, email, password_hash, full_name, email_verified, created_at, updated_at, settings) \
             VALUES (?1,?2,?3,?4,?5,?6,?6,'{}')",
            params![id, email, "not-a-real-hash", "Test User", verified, now],
        )
        .unwrap();
    }

    fn insert_workspace(conn: &Connection, id: &str, name: &str, owner: &str, members: &[&str]) {
        let now = now_iso();
        conn.execute(
            "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)",
            params![id, name, owner, now],
        )
        .unwrap();
        for (index, member) in members.iter().enumerate() {
            let role = if index == 0 { "owner" } else { "member" };
            conn.execute(
                "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1,?2,?3,?4)",
                params![id, member, role, now],
            )
            .unwrap();
        }
    }

    #[test]
    fn deleting_a_shared_member_transfers_authored_rows_to_the_owner() {
        let (db, path) = test_db("delete_shared");
        let owner_id = "11111111-1111-4111-8111-111111111111";
        let member_id = "22222222-2222-4222-8222-222222222222";
        let workspace_id = "33333333-3333-4333-8333-333333333333";
        {
            let conn = db::conn(&db);
            insert_user(&conn, owner_id, "owner@example.com", 1);
            insert_user(&conn, member_id, "member@example.com", 1);
            insert_workspace(
                &conn,
                workspace_id,
                "Shared",
                owner_id,
                &[owner_id, member_id],
            );
            conn.execute(
                "INSERT INTO accounts (_id, userId, workspaceId, name, type, currency, currentBalance, isArchived, data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState) \
                 VALUES ('acc1', ?1, ?2, 'Cash', 'bank', 'USD', 0, 0, '{}', ?3, NULL, ?3, 0, 'synced')",
                params![member_id, workspace_id, now_iso()],
            )
            .unwrap();
        }

        let impact = deletion_impact(&db, member_id).unwrap();
        assert_eq!(impact.retained_record_count, 1);
        assert_eq!(impact.affected_workspaces.len(), 1);
        assert_eq!(impact.affected_workspaces[0].workspace_id, workspace_id);

        delete_account(&db, member_id, "irrelevant").unwrap_err();
        // Password check runs first: the row must still be there with an invalid password.
        {
            let conn = db::conn(&db);
            let still_there: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE id = ?1",
                    params![member_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(still_there, 1);
            conn.execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                params![hash_password("Password123!").unwrap(), member_id],
            )
            .unwrap();
        }

        delete_account(&db, member_id, "Password123!").unwrap();

        let conn = db::conn(&db);
        let owner: String = conn
            .query_row("SELECT userId FROM accounts WHERE _id='acc1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(owner, owner_id);
        let ws_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ws_count, 1);
        let user_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users WHERE id = ?1",
                params![member_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(user_count, 0);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn backfill_marks_preexisting_users_verified() {
        let (db, path) = test_db("backfill");
        let user_id = "44444444-4444-4444-8444-444444444444";
        {
            let conn = db::conn(&db);
            insert_user(&conn, user_id, "legacy@example.com", 0);
        }
        backfill_email_verified(&db).unwrap();
        let conn = db::conn(&db);
        let verified: i64 = conn
            .query_row(
                "SELECT email_verified FROM users WHERE id = ?1",
                params![user_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(verified, 1);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
