import { describe, it, expect, afterEach } from 'vitest'
import { SignJWT, generateKeyPair } from 'jose'
import keypair from '@fixtures/contract/offline-grant-test-keypair.json'
import {
    clearOfflineGrant,
    getStoredOfflineGrant,
    storeOfflineGrant,
    verifyOfflineGrant,
} from '../offlineGrant'
import { createTestOfflineGrant, normalisePem } from '@/test/offlineGrantFixture'

/**
 * Acceptance spec for the server-signed offline session grant (S16, SEC-18).
 *
 * Replaces the old plain `spndr_session_valid_until` localStorage date - forgeable by simply
 * writing a future date into it - with a server-signed JWT the client verifies locally against
 * a public key it cannot use to mint or extend a grant itself. `verifyOfflineGrant` must fail
 * closed in every case except a signature that actually checks out against the configured
 * public key, for the expected user, with every required claim, before its `exp`.
 */

afterEach(async () => {
    await clearOfflineGrant()
})

describe('offlineGrant storage', () => {
    it('round-trips a stored grant', async () => {
        await storeOfflineGrant('some.jwt.value')
        await expect(getStoredOfflineGrant()).resolves.toBe('some.jwt.value')
    })

    it('clears the stored grant', async () => {
        await storeOfflineGrant('some.jwt.value')
        await clearOfflineGrant()
        await expect(getStoredOfflineGrant()).resolves.toBeNull()
    })

    it('storing null keeps the existing grant', async () => {
        await storeOfflineGrant('some.jwt.value')
        await storeOfflineGrant(null)
        await expect(getStoredOfflineGrant()).resolves.toBe('some.jwt.value')
    })
})

describe('verifyOfflineGrant', () => {
    it('accepts a grant signed by the configured key for the expected user', async () => {
        const grant = await createTestOfflineGrant('user1')
        expect(await verifyOfflineGrant(grant, 'user1')).toBe(true)
    })

    it('accepts a grant with no expected user supplied', async () => {
        const grant = await createTestOfflineGrant('user1')
        expect(await verifyOfflineGrant(grant)).toBe(true)
    })

    it('rejects a grant bound to a different user', async () => {
        const grant = await createTestOfflineGrant('user1')
        expect(await verifyOfflineGrant(grant, 'user2')).toBe(false)
    })

    it('rejects an expired grant', async () => {
        const grant = await createTestOfflineGrant('user1', { expiresInSeconds: -3600 })
        expect(await verifyOfflineGrant(grant, 'user1')).toBe(false)
    })

    it('rejects a grant signed with a key other than the configured public key', async () => {
        const { privateKey } = await generateKeyPair('ES256')
        const forged = await new SignJWT({ jti: 'forged-jti' })
            .setProtectedHeader({ alg: 'ES256' })
            .setSubject('user1')
            .setIssuedAt()
            .setIssuer('kanegrowth')
            .setAudience('kanegrowth-offline')
            .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
            .sign(privateKey)

        expect(await verifyOfflineGrant(forged, 'user1')).toBe(false)
    })

    it('rejects a grant missing the expiry claim', async () => {
        const grant = await createTestOfflineGrant('user1', { includeExpiry: false })
        expect(await verifyOfflineGrant(grant, 'user1')).toBe(false)
    })

    it('rejects a grant whose issuer or audience does not match the offline audience', async () => {
        const wrongIssuer = await createTestOfflineGrant('user1', { issuer: 'evil' })
        const wrongAudience = await createTestOfflineGrant('user1', { audience: 'other-app' })

        expect(await verifyOfflineGrant(wrongIssuer, 'user1')).toBe(false)
        expect(await verifyOfflineGrant(wrongAudience, 'user1')).toBe(false)
    })

    it('rejects a null grant', async () => {
        expect(await verifyOfflineGrant(null, 'user1')).toBe(false)
    })

    it('rejects a garbage string that is not a JWT', async () => {
        expect(await verifyOfflineGrant('not-a-jwt', 'user1')).toBe(false)
    })
})

describe('offline grant key parity', () => {
    it('the configured public key matches the shared test keypair', () => {
        expect(normalisePem(import.meta.env.VITE_OFFLINE_GRANT_PUBLIC_KEY ?? '')).toBe(
            normalisePem(keypair.publicKey)
        )
    })
})
