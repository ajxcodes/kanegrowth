use crate::config::Config;
use crate::db::Db;
use crate::models::{AuthData, UserDto};
use crate::util::now_iso;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::rngs::OsRng;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

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

pub fn user_to_dto(
    id: String,
    email: String,
    full_name: Option<String>,
    email_verified: i64,
    created_at: String,
) -> UserDto {
    UserDto {
        id,
        email,
        full_name,
        email_verified: email_verified != 0,
        created_at,
    }
}

pub fn register_user(
    db: &Db,
    config: &Config,
    email: &str,
    password: &str,
    full_name: Option<String>,
) -> Result<AuthData, String> {
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
    conn.execute(
        "INSERT INTO users (id, email, password_hash, full_name, email_verified, created_at, updated_at) VALUES (?1,?2,?3,?4,0,?5,?5)",
        params![id, email, hash, full_name, now],
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
    issue_tokens(db, config, &id, email, full_name)
}

pub fn issue_tokens(
    db: &Db,
    config: &Config,
    user_id: &str,
    email: &str,
    full_name: Option<String>,
) -> Result<AuthData, String> {
    let access = create_access_token(config, user_id, email)?;
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

    // fetch created_at
    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| now.clone());

    let user = user_to_dto(
        user_id.to_string(),
        email.to_string(),
        full_name,
        0,
        created_at,
    );
    Ok(AuthData {
        token: access,
        refresh_token: refresh,
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
    let row: Result<(String, String, Option<String>, i64, String), _> = conn.query_row(
        "SELECT id, password_hash, full_name, email_verified, created_at FROM users WHERE email = ?1",
        params![email],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    );
    let (id, hash, full_name, ev, created_at) =
        row.map_err(|_| "invalid credentials".to_string())?;
    if !verify_password(password, &hash) {
        return Err("invalid credentials".to_string());
    }
    drop(conn);
    issue_tokens_with_created(db, config, &id, email, full_name, ev, created_at)
}

fn issue_tokens_with_created(
    db: &Db,
    config: &Config,
    user_id: &str,
    email: &str,
    full_name: Option<String>,
    ev: i64,
    created_at: String,
) -> Result<AuthData, String> {
    let access = create_access_token(config, user_id, email)?;
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
    let user = user_to_dto(
        user_id.to_string(),
        email.to_string(),
        full_name,
        ev,
        created_at,
    );
    Ok(AuthData {
        token: access,
        refresh_token: refresh,
        user,
    })
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

    // fetch user
    let (email, full_name, ev, created_at): (String, Option<String>, i64, String) = conn
        .query_row(
            "SELECT email, full_name, email_verified, created_at FROM users WHERE id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    drop(conn);
    issue_tokens_with_created(db, config, &user_id, &email, full_name, ev, created_at)
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
    let row: (String, Option<String>, i64, String) = conn
        .query_row(
            "SELECT email, full_name, email_verified, created_at FROM users WHERE id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(user_to_dto(user_id.to_string(), row.0, row.1, row.2, row.3))
}

pub fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}
