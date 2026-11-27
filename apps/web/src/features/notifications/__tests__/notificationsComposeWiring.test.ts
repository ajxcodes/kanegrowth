import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Static guard for AC4/TR-23: no Docker daemon required, just the committed compose wiring.
const composePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../docker-compose.yml'
)
const compose = readFileSync(composePath, 'utf8')

describe('docker-compose notifications wiring', () => {
    it('compose defines a working ntfy service and wires the server env', () => {
        expect(compose).toMatch(/ntfy:\s*\n\s+image:\s+binwiederhier\/ntfy:/)
        expect(compose).toContain('NTFY_URL: "http://ntfy:80"')
        expect(compose).toMatch(/NTFY_TOPIC:\s*\$\{NTFY_TOPIC:-kanegrowth\}/)
        expect(compose).toContain('NTFY_TOKEN: ${NTFY_TOKEN:-}')
        expect(compose).toContain('ntfy-cache')
        expect(compose).toMatch(/depends_on:[\s\S]*?ntfy:/)
    })
})
