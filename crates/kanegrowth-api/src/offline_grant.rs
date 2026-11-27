//! Server-signed offline session grant (issue #18).
//!
//! A stateless ES256 JWT the client verifies locally with the matching public key, so it can
//! restore a cached session while the network is unreachable without holding a key it could use
//! to mint or extend a grant itself.
//!
//! Policy:
//! - **TTL:** `config.offline_grant_ttl_secs`, which defaults to and never exceeds the
//!   refresh-token lifetime (`refresh_ttl_days * 86_400`), so a grant can never outlive the
//!   credential it was issued with.
//! - **Rotation:** a fresh `jti`, `iat` and `exp` is minted on every register/login/refresh. The
//!   client overwrites its stored grant; there is no server-side denylist, so a copied grant stays
//!   usable until `exp` and logout only removes the local copy. The bounded TTL is the mitigation
//!   (clock-rollback defences are out of scope for this issue).
//! - **Claims:** `sub` (user id), `iat`, `exp`, `iss = "kanegrowth"`, `aud = "kanegrowth-offline"`,
//!   `jti`.
//!
//! A missing or malformed signing key makes [`issue`] return `Err`; `auth::issue_tokens` treats
//! that as "no grant" so online authentication keeps working while offline restore fails closed.

use crate::config::Config;
use chrono::Utc;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ISSUER: &str = "kanegrowth";
pub const AUDIENCE: &str = "kanegrowth-offline";

#[derive(Debug, Serialize, Deserialize)]
struct OfflineGrantClaims {
    sub: String,
    iat: i64,
    exp: i64,
    iss: String,
    aud: String,
    jti: String,
}

/// Signs a new offline session grant for `user_id`, stamped at the current time.
pub fn issue(config: &Config, user_id: &str) -> Result<String, String> {
    issue_at(config, user_id, Utc::now().timestamp())
}

/// Shared by [`issue`] and the tests: the issuance timestamp is caller-supplied so expiry can be
/// asserted deterministically.
fn issue_at(config: &Config, user_id: &str, iat: i64) -> Result<String, String> {
    let pem = config
        .offline_grant_private_key
        .as_deref()
        .ok_or_else(|| "offline grant signing key is not configured".to_string())?;
    // Accept a PEM supplied with literal `\n` escapes (the `.env`/compose form) as well as one
    // with real newlines.
    let normalised_pem = pem.replace("\\n", "\n");
    // The error is formatted without the PEM - the key material must never reach a log.
    let key = EncodingKey::from_ec_pem(normalised_pem.as_bytes())
        .map_err(|e| format!("invalid offline grant private key: {e}"))?;

    let claims = OfflineGrantClaims {
        sub: user_id.to_string(),
        iat,
        exp: iat + config.offline_grant_ttl_secs,
        iss: ISSUER.to_string(),
        aud: AUDIENCE.to_string(),
        jti: Uuid::new_v4().to_string(),
    };

    encode(&Header::new(Algorithm::ES256), &claims, &key)
        .map_err(|e| format!("failed to sign offline grant: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, DecodingKey, Validation};

    fn test_keypair() -> (String, String) {
        let raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/fixtures/contract/offline-grant-test-keypair.json"
        ))
        .unwrap();
        (
            raw["privateKey"].as_str().unwrap().to_string(),
            raw["publicKey"].as_str().unwrap().to_string(),
        )
    }

    fn test_config(private_key: Option<String>, ttl_secs: i64) -> Config {
        Config {
            bind: "127.0.0.1:0".to_string(),
            db_path: ":memory:".to_string(),
            jwt_secret: "test-secret".to_string(),
            cors_origins: vec!["*".to_string()],
            ntfy_url: None,
            ntfy_topic: None,
            access_ttl_secs: 3600,
            refresh_ttl_days: 30,
            require_email_verification: false,
            dev_auth_tokens: false,
            offline_grant_private_key: private_key,
            offline_grant_ttl_secs: ttl_secs,
        }
    }

    fn validation(validate_exp: bool) -> Validation {
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_required_spec_claims(&["sub", "iat", "exp", "jti", "iss", "aud"]);
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[AUDIENCE]);
        validation.validate_exp = validate_exp;
        validation.leeway = 0;
        validation
    }

    fn decode_claims(
        token: &str,
        public_key: &str,
        validation: &Validation,
    ) -> Result<OfflineGrantClaims, jsonwebtoken::errors::Error> {
        let key = DecodingKey::from_ec_pem(public_key.as_bytes()).unwrap();
        decode::<OfflineGrantClaims>(token, &key, validation).map(|data| data.claims)
    }

    #[test]
    fn issue_uses_the_configured_ttl_and_all_required_claims() {
        let (private_key, public_key) = test_keypair();
        let config = test_config(Some(private_key), 600);

        let token = issue(&config, "user-1").unwrap();
        let claims = decode_claims(&token, &public_key, &validation(true)).unwrap();

        assert_eq!(claims.exp - claims.iat, 600);
        assert_eq!(claims.iss, ISSUER);
        assert_eq!(claims.aud, AUDIENCE);
        assert_eq!(claims.sub, "user-1");
        assert!(!claims.jti.is_empty());
    }

    #[test]
    fn a_negative_ttl_produces_an_already_expired_grant() {
        let (private_key, public_key) = test_keypair();
        let config = test_config(Some(private_key), -60);

        let token = issue(&config, "user-1").unwrap();
        let claims = decode_claims(&token, &public_key, &validation(false)).unwrap();
        assert!(claims.exp < claims.iat);

        // With `validate_exp` on, the same token is rejected.
        assert!(decode_claims(&token, &public_key, &validation(true)).is_err());
    }

    #[test]
    fn unconfigured_signing_key_is_an_error() {
        let config = test_config(None, 600);

        let error = issue(&config, "user-1").unwrap_err();

        assert_eq!(error, "offline grant signing key is not configured");
    }
}
