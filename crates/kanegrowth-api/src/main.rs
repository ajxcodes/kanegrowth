mod auth;
mod config;
mod db;
mod entity_map;
mod migrations;
mod models;
mod ntfy;
mod sync;
mod util;
mod workspaces;

use crate::auth::{extract_bearer, validate_access_token};
use crate::config::Config;
use crate::db::Db;
use crate::models::*;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Deserialize;

use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct AppState {
    db: Db,
    config: Config,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let config = Config::from_env();
    let db = db::open_db(&config.db_path).expect("db open");
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
    };

    // CORS
    let cors = if config.cors_origins.iter().any(|o| o == "*") {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let origins: Vec<axum::http::HeaderValue> = config
            .cors_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api/v1", api_router())
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind).await.unwrap();
    tracing::info!("listening on {}", config.bind);
    axum::serve(listener, app).await.unwrap();
}

fn api_router() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(auth_register))
        .route("/auth/login", post(auth_login))
        .route("/auth/refresh", post(auth_refresh))
        .route("/auth/logout", post(auth_logout))
        .route("/auth/logout-all", post(auth_logout_all))
        .route("/auth/user", get(auth_user))
        .route("/workspaces", get(ws_list).post(ws_create))
        .route("/workspaces/:id", get(ws_get).put(ws_update))
        .route("/sync/bootstrap", get(sync_bootstrap))
        .route("/sync/pull", get(sync_pull))
        .route("/sync/push", post(sync_push))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status":"ok"}))
}

// --- refresh-token cookie helpers (web session persistence, PD-2) ---
const REFRESH_COOKIE: &str = "kg_refresh";
const REFRESH_COOKIE_PATH: &str = "/api/v1/auth";

fn is_secure_request(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

fn build_refresh_cookie(token: &str, max_age_secs: i64, secure: bool) -> String {
    let mut c = format!(
        "{}={}; HttpOnly; Path={}; SameSite=Lax; Max-Age={}",
        REFRESH_COOKIE, token, REFRESH_COOKIE_PATH, max_age_secs
    );
    if secure {
        c.push_str("; Secure");
    }
    c
}

fn clear_refresh_cookie(secure: bool) -> String {
    let mut c = format!(
        "{}=; HttpOnly; Path={}; SameSite=Lax; Max-Age=0",
        REFRESH_COOKIE, REFRESH_COOKIE_PATH
    );
    if secure {
        c.push_str("; Secure");
    }
    c
}

fn refresh_token_from_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    let prefix = format!("{}=", REFRESH_COOKIE);
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix(&prefix) {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn set_cookie_headers(cookie: String) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        headers.insert(header::SET_COOKIE, v);
    }
    headers
}

// --- auth handlers ---
async fn auth_register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterRequest>,
) -> Result<(HeaderMap, Json<ApiResponse<AuthData>>), (StatusCode, Json<serde_json::Value>)> {
    match crate::auth::register_user(
        &state.db,
        &state.config,
        &body.email,
        &body.password,
        body.full_name,
    ) {
        Ok(data) => {
            let cookie = build_refresh_cookie(
                &data.refresh_token,
                state.config.refresh_ttl_days * 86_400,
                is_secure_request(&headers),
            );
            Ok((set_cookie_headers(cookie), Json(ApiResponse::data(data))))
        }
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )),
    }
}

async fn auth_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<(HeaderMap, Json<ApiResponse<AuthData>>), (StatusCode, Json<serde_json::Value>)> {
    match crate::auth::login_user(&state.db, &state.config, &body.email, &body.password) {
        Ok(data) => {
            let cookie = build_refresh_cookie(
                &data.refresh_token,
                state.config.refresh_ttl_days * 86_400,
                is_secure_request(&headers),
            );
            Ok((set_cookie_headers(cookie), Json(ApiResponse::data(data))))
        }
        Err(_) => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"invalid credentials"})),
        )),
    }
}

async fn auth_refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RefreshRequest>,
) -> Result<(HeaderMap, Json<ApiResponse<AuthData>>), (StatusCode, Json<serde_json::Value>)> {
    let rt = body
        .refresh_token
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| refresh_token_from_cookie(&headers))
        .unwrap_or_default();
    if rt.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":"missing refresh token"})),
        ));
    }
    match crate::auth::refresh_access(&state.db, &state.config, &rt) {
        Ok(data) => {
            let cookie = build_refresh_cookie(
                &data.refresh_token,
                state.config.refresh_ttl_days * 86_400,
                is_secure_request(&headers),
            );
            Ok((set_cookie_headers(cookie), Json(ApiResponse::data(data))))
        }
        Err(_) => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"invalid refresh token"})),
        )),
    }
}

async fn auth_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RefreshRequest>,
) -> Result<(HeaderMap, Json<ApiResponse<serde_json::Value>>), (StatusCode, Json<serde_json::Value>)>
{
    let rt = body
        .refresh_token
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| refresh_token_from_cookie(&headers));
    if let Some(rt) = &rt {
        let _ = crate::auth::revoke_refresh(&state.db, rt);
    }
    let cookie = clear_refresh_cookie(is_secure_request(&headers));
    Ok((
        set_cookie_headers(cookie),
        Json(ApiResponse::data(serde_json::json!({"ok": true}))),
    ))
}

async fn auth_logout_all(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    let _ = crate::auth::revoke_all(&state.db, &claims.sub);
    Ok(Json(ApiResponse::data(serde_json::json!({"ok": true}))))
}

async fn auth_user(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<UserDto>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match crate::auth::get_user(&state.db, &claims.sub) {
        Ok(u) => Ok(Json(ApiResponse::data(u))),
        Err(_) => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"not found"})),
        )),
    }
}

// --- workspace handlers ---
async fn ws_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<Vec<WorkspaceDto>>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match crate::workspaces::list_workspaces(&state.db, &claims.sub) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )),
    }
}

async fn ws_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceCreateRequest>,
) -> Result<Json<ApiResponse<WorkspaceDto>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match crate::workspaces::create_workspace(&state.db, &claims.sub, &body.name) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )),
    }
}

async fn ws_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<WorkspaceDto>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match crate::workspaces::get_workspace(&state.db, &id, &claims.sub) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => {
            if e == "forbidden" {
                Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))))
            } else {
                Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e}))))
            }
        }
    }
}

async fn ws_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<WorkspaceCreateRequest>,
) -> Result<Json<ApiResponse<WorkspaceDto>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match crate::workspaces::update_workspace(&state.db, &id, &claims.sub, &body.name) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => {
            if e == "forbidden" {
                Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))))
            } else {
                Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": e})),
                ))
            }
        }
    }
}

// --- sync handlers ---
#[derive(Deserialize)]
struct BootstrapQuery {
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

async fn sync_bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<BootstrapQuery>,
) -> Result<Json<ApiResponse<BootstrapSnapshot>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match sync::bootstrap(&state.db, &claims.sub, q.workspace_id) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => {
            if e == "forbidden" {
                Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))))
            } else {
                Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": e})),
                ))
            }
        }
    }
}

#[derive(Deserialize)]
struct PullQuery {
    checkpoint: Option<String>,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

async fn sync_pull(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PullQuery>,
) -> Result<Json<ApiResponse<PullPage>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match sync::pull(&state.db, &claims.sub, q.workspace_id, q.checkpoint) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => {
            if e == "forbidden" {
                Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))))
            } else {
                Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": e})),
                ))
            }
        }
    }
}

async fn sync_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SyncPushRequest>,
) -> Result<Json<ApiResponse<PushResponse>>, (StatusCode, Json<serde_json::Value>)> {
    let token = extract_bearer(&headers).ok_or((
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error":"unauthorized"})),
    ))?;
    let claims = validate_access_token(&state.config, &token).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"unauthorized"})),
        )
    })?;
    match sync::push(&state.db, &claims.sub, body.workspace_id.clone(), body) {
        Ok(v) => Ok(Json(ApiResponse::data(v))),
        Err(e) => {
            if e == "forbidden" {
                Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))))
            } else {
                Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": e})),
                ))
            }
        }
    }
}
