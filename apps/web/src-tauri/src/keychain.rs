//! SEC-11 / BUG-24: the packaged desktop app is cross-site to `api.kanegrowth.app`, so the
//! `SameSite=Lax` refresh cookie is never sent and the cookie-only refresh path logs the user
//! out at the access-token TTL. Instead the desktop client receives the rotated refresh token in
//! the auth response body and stores it here, in the OS-provided credential store:
//! Windows Credential Manager, macOS Keychain, or the Linux Secret Service.
//!
//! SEC-42: these commands manage exactly two fixed entries — the refresh token and the
//! server-signed offline session grant (issue #18). They take **no caller-supplied key**, so the
//! webview cannot use them as a generic OS-credential-store read/write/delete primitive over the
//! highest-value store on the machine. `db_key.rs` owns a separate, equally fixed entry for the
//! SQLCipher key.
//!
//! The frontend (`src/lib/refreshTokenStore.ts`, `src/lib/offlineGrant.ts`) treats every failure
//! as non-fatal - a locked or unavailable keychain just means the session won't outlive the
//! access-token TTL / won't restore offline on that machine, which is the pre-fix behaviour.
//! Nothing here ever falls back to plaintext storage.

use keyring::{Entry, Error as KeyringError};

// NOTE: The keychain service / account were renamed during the rebrand (previous values were the
// pre-rebrand app identifier and `<old-brand>_refresh_token`). Dropping any pre-rebrand sessions on
// upgrade is intentional: KaneGrowth is a new fork with no existing installs, so no migration is provided.

/// Keychain service name. Matches the Tauri bundle identifier so the entry is easy to locate in
/// Credential Manager / Keychain Access when debugging.
const SERVICE: &str = "com.kanegrowth.app";

/// The desktop refresh token entry. Fixed in Rust, never passed from the webview (SEC-42).
const REFRESH_TOKEN_ACCOUNT: &str = "kanegrowth_refresh_token";

/// The offline session grant entry (issue #18). Fixed in Rust, never passed from the webview.
const OFFLINE_GRANT_ACCOUNT: &str = "kanegrowth_offline_grant";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, REFRESH_TOKEN_ACCOUNT).map_err(|e| e.to_string())
}

fn grant_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, OFFLINE_GRANT_ACCOUNT).map_err(|e| e.to_string())
}

/// Store (or overwrite) the desktop refresh token in the OS keychain.
#[tauri::command]
pub fn keychain_set(value: String) -> Result<(), String> {
    entry()?.set_password(&value).map_err(|e| e.to_string())
}

/// Read the stored refresh token, or `None` when there is no such entry.
#[tauri::command]
pub fn keychain_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the stored refresh token. A missing entry is treated as success (idempotent).
#[tauri::command]
pub fn keychain_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Store (or overwrite) the server-signed offline session grant in the OS keychain.
#[tauri::command]
pub fn offline_grant_set(value: String) -> Result<(), String> {
    grant_entry()?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

/// Read the stored offline session grant, or `None` when there is no such entry.
#[tauri::command]
pub fn offline_grant_get() -> Result<Option<String>, String> {
    match grant_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the stored offline session grant. A missing entry is treated as success (idempotent).
#[tauri::command]
pub fn offline_grant_delete() -> Result<(), String> {
    match grant_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn keychain_service_and_fixed_accounts_are_pinned() {
        assert_eq!(super::SERVICE, "com.kanegrowth.app");
        // SEC-42: the account names are Rust constants, not webview-supplied arguments.
        assert_eq!(super::REFRESH_TOKEN_ACCOUNT, "kanegrowth_refresh_token");
        assert_eq!(super::OFFLINE_GRANT_ACCOUNT, "kanegrowth_offline_grant");
    }
}
