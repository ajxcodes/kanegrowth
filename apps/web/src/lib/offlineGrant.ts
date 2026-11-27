import { importSPKI, jwtVerify } from 'jose'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './isTauri'

/**
 * Server-signed offline session grant (S16, SEC-18). Replaces the old plain
 * `spndr_session_valid_until` localStorage date, which a user could simply rewrite to extend
 * their own offline access forever, with a JWT the server signs
 * (`crates/kanegrowth-api/src/offline_grant.rs`) and this module verifies locally with the
 * matching public key - the client holds no key capable of minting or extending one itself.
 * Every successful login/refresh rolls the grant forward; `UserContext.restoreSession` consults
 * it only when the server can't be reached.
 *
 * Storage: on the desktop (Tauri) client the grant lives in the same OS keychain as the refresh
 * token (`src-tauri/src/keychain.rs`), through the fixed-entry `offline_grant_*` commands; on the
 * web it stays in `localStorage`, where there is no JS-held refresh token to protect.
 *
 * Storing an empty/undefined grant is a no-op: a rolling deployment or a transient signing
 * failure must never delete a still-valid stored grant. Deletion is explicit via
 * `clearOfflineGrant()` on logout/wipe.
 */

const OFFLINE_GRANT_KEY = 'kanegrowth_offline_grant'
const OFFLINE_GRANT_ALGORITHM = 'ES256'
const OFFLINE_GRANT_ISSUER = 'kanegrowth'
const OFFLINE_GRANT_AUDIENCE = 'kanegrowth-offline'
/** Tolerance for a client clock that runs slightly ahead of the signing server. */
const OFFLINE_GRANT_CLOCK_TOLERANCE_SECONDS = 60
const OFFLINE_GRANT_REQUIRED_CLAIMS = ['sub', 'iat', 'exp', 'jti']

export const storeOfflineGrant = async (grant: string | null | undefined): Promise<void> => {
    if (!grant) return
    if (isTauriRuntime()) {
        try {
            await invoke('offline_grant_set', { value: grant })
        } catch (error) {
            console.error('[offlineGrant] keychain write failed:', error)
        }
        return
    }
    localStorage.setItem(OFFLINE_GRANT_KEY, grant)
}

export const getStoredOfflineGrant = async (): Promise<string | null> => {
    if (isTauriRuntime()) {
        try {
            const value = await invoke<string | null>('offline_grant_get')
            return value && value.length > 0 ? value : null
        } catch (error) {
            console.error('[offlineGrant] keychain read failed:', error)
            return null
        }
    }
    return localStorage.getItem(OFFLINE_GRANT_KEY)
}

export const clearOfflineGrant = async (): Promise<void> => {
    if (isTauriRuntime()) {
        try {
            await invoke('offline_grant_delete')
        } catch (error) {
            console.error('[offlineGrant] keychain clear failed:', error)
        }
        return
    }
    localStorage.removeItem(OFFLINE_GRANT_KEY)
}

const getPublicKey = async (): Promise<CryptoKey | null> => {
    const pem = import.meta.env.VITE_OFFLINE_GRANT_PUBLIC_KEY
    if (!pem) return null
    try {
        return await importSPKI(pem.replace(/\\n/g, '\n'), OFFLINE_GRANT_ALGORITHM)
    } catch {
        return null
    }
}

/**
 * Fails closed: a missing grant, a missing/invalid public key, a tampered signature, a grant
 * bound to a different user, a grant missing a required claim, a wrong issuer/audience, or an
 * expired `exp` all return false. There is no default-allow path - unlike the old plain date, a
 * device with no grant at all gets no offline fallback.
 */
export const verifyOfflineGrant = async (
    grant: string | null,
    expectedUserId?: string
): Promise<boolean> => {
    if (!grant) return false

    const key = await getPublicKey()
    if (!key) return false

    try {
        const { payload } = await jwtVerify(grant, key, {
            algorithms: [OFFLINE_GRANT_ALGORITHM],
            issuer: OFFLINE_GRANT_ISSUER,
            audience: OFFLINE_GRANT_AUDIENCE,
            requiredClaims: OFFLINE_GRANT_REQUIRED_CLAIMS,
            clockTolerance: OFFLINE_GRANT_CLOCK_TOLERANCE_SECONDS,
        })
        if (expectedUserId && payload.sub !== expectedUserId) return false
        return true
    } catch {
        return false
    }
}
