mod auth;
mod config;
mod db;
mod entity_map;
mod migrations;
mod models;
mod ntfy;
mod sync;
mod workspaces;

use crate::auth::{extract_bearer, validate_access_token};
use crate::config::Config;
use crate::db::Db;
use crate::models::*;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
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

// --- auth handlers ---
async fn auth_register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<ApiResponse<AuthData>>, (StatusCode, Json<serde_json::Value>)> {
    match crate::auth::register_user(
        &state.db,
        &state.config,
        &body.email,
        &body.password,
        body.full_name,
    ) {
        Ok(data) => Ok(Json(ApiResponse::data(data))),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )),
    }
}

async fn auth_login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<ApiResponse<AuthData>>, (StatusCode, Json<serde_json::Value>)> {
    match crate::auth::login_user(&state.db, &state.config, &body.email, &body.password) {
        Ok(data) => Ok(Json(ApiResponse::data(data))),
        Err(_) => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"invalid credentials"})),
        )),
    }
}

async fn auth_refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<Json<ApiResponse<AuthData>>, (StatusCode, Json<serde_json::Value>)> {
    let rt = body.refresh_token.clone().unwrap_or_default();
    if rt.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":"missing refresh token"})),
        ));
    }
    match crate::auth::refresh_access(&state.db, &state.config, &rt) {
        Ok(data) => Ok(Json(ApiResponse::data(data))),
        Err(_) => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"invalid refresh token"})),
        )),
    }
}

async fn auth_logout(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<serde_json::Value>)> {
    if let Some(rt) = &body.refresh_token {
        let _ = crate::auth::revoke_refresh(&state.db, rt);
    }
    Ok(Json(ApiResponse::data(serde_json::json!({"ok": true}))))
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
