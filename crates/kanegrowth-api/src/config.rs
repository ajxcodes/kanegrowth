use std::env;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Config {
    pub bind: String,
    pub db_path: String,
    pub jwt_secret: String,
    pub cors_origins: Vec<String>,
    pub ntfy_url: Option<String>,
    pub ntfy_topic: Option<String>,
    pub access_ttl_secs: i64,
    pub refresh_ttl_days: i64,
}

impl Config {
    pub fn from_env() -> Self {
        let bind = if let Ok(b) = env::var("KANEGROWTH_BIND") {
            b
        } else {
            let host = env::var("KANEGROWTH_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
            let port = env::var("KANEGROWTH_PORT").unwrap_or_else(|_| "5000".to_string());
            format!("{host}:{port}")
        };
        let db_path = env::var("KANEGROWTH_DB_PATH")
            .or_else(|_| env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "kanegrowth.db".to_string());
        // Strip sqlite: prefix if present
        let db_path = db_path.trim_start_matches("sqlite:").to_string();
        let jwt_secret = env::var("KANEGROWTH_JWT_SECRET")
            .unwrap_or_else(|_| "change-me-in-production".to_string());
        let cors_raw = env::var("KANEGROWTH_CORS_ORIGINS").unwrap_or_else(|_| "*".to_string());
        let mut cors_origins: Vec<String> = cors_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if cors_origins.is_empty() {
            cors_origins = vec!["*".to_string()];
        }
        let ntfy_url = env::var("NTFY_URL").ok().filter(|s| !s.is_empty());
        let ntfy_topic = env::var("NTFY_TOPIC").ok().filter(|s| !s.is_empty());
        let access_ttl_secs = env::var("KANEGROWTH_ACCESS_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3600);
        let refresh_ttl_days = env::var("KANEGROWTH_REFRESH_TTL_DAYS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        Self {
            bind,
            db_path,
            jwt_secret,
            cors_origins,
            ntfy_url,
            ntfy_topic,
            access_ttl_secs,
            refresh_ttl_days,
        }
    }
}
