import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Issue #18: the single-container web image defaults to `VITE_LOCAL_FIRST=true`, so the deployed
 * SPA must be able to verify the offline grant the server issues. Only the **public** half is
 * baked at build time; the **private** half is a runtime secret supplied through the operator
 * environment. This is a plain string-content test - no Docker daemon required.
 */

const readRepoFile = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const dockerfile = readRepoFile('../../../../../Dockerfile')
const compose = readRepoFile('../../../../../docker-compose.yml')

describe('Docker offline-grant wiring', () => {
    it('the Docker image bakes the offline grant public key and never the private key', () => {
        const frontendStage = dockerfile.slice(
            dockerfile.indexOf('AS frontend-build'),
            dockerfile.indexOf('# ---------- Stage 2')
        )

        // (a) the frontend build declares the public-key ARG and a quoted ENV entry.
        expect(frontendStage).toContain('ARG VITE_OFFLINE_GRANT_PUBLIC_KEY=')
        expect(frontendStage).toContain('VITE_OFFLINE_GRANT_PUBLIC_KEY="$VITE_OFFLINE_GRANT_PUBLIC_KEY"')

        // (b) the private half never enters a build stage.
        expect(dockerfile).not.toContain('OFFLINE_GRANT_PRIVATE_KEY')

        // (c) compose passes the public key as a build arg...
        const [beforeEnvironment = ''] = compose.split('environment:')
        expect(compose).toContain('build:')
        expect(compose).toContain('VITE_OFFLINE_GRANT_PUBLIC_KEY: ${VITE_OFFLINE_GRANT_PUBLIC_KEY:-}')
        // ...and carries the private key only under `environment:` (runtime secret).
        expect(beforeEnvironment).not.toContain('OFFLINE_GRANT_PRIVATE_KEY')
        expect(compose.slice(compose.indexOf('environment:'))).toContain(
            'KANEGROWTH_OFFLINE_GRANT_PRIVATE_KEY: ${KANEGROWTH_OFFLINE_GRANT_PRIVATE_KEY:-}'
        )
    })
})
