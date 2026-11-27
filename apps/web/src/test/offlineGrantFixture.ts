import { SignJWT, importPKCS8 } from 'jose'
import keypair from '@fixtures/contract/offline-grant-test-keypair.json'

/**
 * Test-only ES256 keypair for the offline session grant (S16, SEC-18). Both halves live in
 * `shared/fixtures/contract/offline-grant-test-keypair.json` so the web suite and the Rust server
 * tests can never drift; the matching public half is also exposed to Vite/Vitest "test" mode as
 * `VITE_OFFLINE_GRANT_PUBLIC_KEY` (`.env.test`). Never reused anywhere outside the suites.
 */

/** Accepts a PEM with either real newlines or the literal `\n` escapes used in env files. */
export const normalisePem = (value: string): string => value.replace(/\\n/g, '\n')

export interface TestOfflineGrantOptions {
    expiresInSeconds?: number
    issuer?: string
    audience?: string
    includeExpiry?: boolean
    includeIssuer?: boolean
    includeAudience?: boolean
}

export const createTestOfflineGrant = async (
    userId: string,
    options: TestOfflineGrantOptions = {}
): Promise<string> => {
    const key = await importPKCS8(normalisePem(keypair.privateKey), 'ES256')
    const expiresIn = options.expiresInSeconds ?? 30 * 24 * 60 * 60

    let grant = new SignJWT({ jti: crypto.randomUUID() })
        .setProtectedHeader({ alg: 'ES256' })
        .setSubject(userId)
        .setIssuedAt()

    if (options.includeExpiry !== false) {
        grant = grant.setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    }
    if (options.includeIssuer !== false) {
        grant = grant.setIssuer(options.issuer ?? 'kanegrowth')
    }
    if (options.includeAudience !== false) {
        grant = grant.setAudience(options.audience ?? 'kanegrowth-offline')
    }

    return grant.sign(key)
}
