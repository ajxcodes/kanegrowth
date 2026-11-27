use std::env;

#[derive(Clone)]
#[allow(dead_code)]
pub struct Config {
    pub bind: String,
    pub db_path: String,
    pub jwt_secret: String,
    pub cors_origins: Vec<String>,
    pub ntfy_url: Option<String>,
    pub ntfy_topic: Option<String>,
    /// Bearer token for a protected ntfy topic. Never logged; redacted in the `Debug` impl.
    pub ntfy_token: Option<String>,
    pub access_ttl_secs: i64,
    pub refresh_ttl_days: i64,
    pub require_email_verification: bool,
    pub dev_auth_tokens: bool,
    /// ES256 private key (PEM) used to sign offline session grants (issue #18). `None` means the
    /// server issues no grants - online authentication still works, offline restore fails closed.
    pub offline_grant_private_key: Option<String>,
    /// Lifetime of an issued offline grant in seconds. Defaults to and is clamped to the
    /// refresh-token lifetime, so a grant can never outlive the credential it was issued with.
    pub offline_grant_ttl_secs: i64,
}

/// Manual `Debug`: the signing key is a secret, so it must never appear in a log line. Every
/// other field prints verbatim, and a configured key prints only as `Some("<redacted>")`.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("db_path", &self.db_path)
            .field("jwt_secret", &self.jwt_secret)
            .field("cors_origins", &self.cors_origins)
            .field("ntfy_url", &self.ntfy_url)
            .field("ntfy_topic", &self.ntfy_topic)
            .field(
                "ntfy_token",
                &self.ntfy_token.as_ref().map(|_| "<redacted>"),
            )
            .field("access_ttl_secs", &self.access_ttl_secs)
            .field("refresh_ttl_days", &self.refresh_ttl_days)
            .field(
                "require_email_verification",
                &self.require_email_verification,
            )
            .field("dev_auth_tokens", &self.dev_auth_tokens)
            .field(
                "offline_grant_private_key",
                &self
                    .offline_grant_private_key
                    .as_ref()
                    .map(|_| "<redacted>"),
            )
            .field("offline_grant_ttl_secs", &self.offline_grant_ttl_secs)
            .finish()
    }
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
        let ntfy_token = env::var("NTFY_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let access_ttl_secs = env::var("KANEGROWTH_ACCESS_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3600);
        let refresh_ttl_days: i64 = env::var("KANEGROWTH_REFRESH_TTL_DAYS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        let parse_flag = |name: &str| {
            env::var(name)
                .map(|v| {
                    let v = v.trim().to_ascii_lowercase();
                    v == "1" || v == "true"
                })
                .unwrap_or(false)
        };
        let require_email_verification = parse_flag("KANEGROWTH_REQUIRE_EMAIL_VERIFICATION");
        let dev_auth_tokens = parse_flag("KANEGROWTH_DEV_AUTH_TOKENS");

        // Offline session grant (issue #18). An empty/absent key means "no grants" - never a
        // failed login - so a rolling deploy or a missing secret degrades to today's behaviour.
        let offline_grant_private_key = env::var("KANEGROWTH_OFFLINE_GRANT_PRIVATE_KEY")
            .or_else(|_| env::var("OFFLINE_GRANT_PRIVATE_KEY"))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let refresh_ttl_secs = refresh_ttl_days * 86_400;
        let offline_grant_ttl_secs = env::var("KANEGROWTH_OFFLINE_GRANT_TTL_SECS")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(refresh_ttl_secs)
            .min(refresh_ttl_secs);

        Self {
            bind,
            db_path,
            jwt_secret,
            cors_origins,
            ntfy_url,
            ntfy_topic,
            ntfy_token,
            access_ttl_secs,
            refresh_ttl_days,
            require_email_verification,
            dev_auth_tokens,
            offline_grant_private_key,
            offline_grant_ttl_secs,
        }
    }
}
