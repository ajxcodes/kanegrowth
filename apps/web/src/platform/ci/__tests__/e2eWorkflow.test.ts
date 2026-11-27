import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Issue #17: the real feature E2E suites under `e2e/` must run on every relevant PR, on both the
// Desktop (1280x800) and Mobile (390x844) projects, against the standalone bundle built once by
// the `frontend` CI job. These are static guards: they fail when the workflow stops running the
// whole suite, when the root Playwright config stops discovering `e2e/`, when the bundle is
// rebuilt inside the E2E job instead of reused, or when operator documentation drops a required
// check name.

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../../../..')

const read = (relativePath: string): string => readFileSync(resolve(repoRoot, relativePath), 'utf8')

const REQUIRED_SPECS = ['analytics', 'branding', 'envelope-budgeting', 'standalone-demo-data']

/** Slice one `jobs.<id>` mapping out of the workflow so assertions cannot match a sibling job. */
const jobBlock = (workflow: string, jobId: string): string => {
    const lines = workflow.split('\n')
    const start = lines.findIndex((line) => line === `  ${jobId}:`)
    if (start === -1) throw new Error(`job "${jobId}" is missing from .github/workflows/ci.yml`)
    const body = lines.slice(start + 1)
    const end = body.findIndex((line) => /^ {2}[a-z0-9-]+:$/.test(line))
    return (end === -1 ? body : body.slice(0, end)).join('\n')
}

describe('CI runs the real feature E2E suites (issue #17)', () => {
    const workflow = read('.github/workflows/ci.yml')
    const rootPackage = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const playwrightConfig = read('playwright.config.ts')
    const docs = read('docs/testing.md')

    it('runs every root e2e spec through the standalone job with no spec or project filter', () => {
        const job = jobBlock(workflow, 'e2e-standalone')
        expect(job).toContain('run: npm run test:e2e')
        expect(job).not.toContain('spec.ts')
        expect(job).not.toContain('--grep')
        expect(job).not.toContain('--project')
        expect(job).not.toContain('continue-on-error')
        expect(job).toMatch(/needs:\s*\[[^\]]*frontend[^\]]*\]/)
        expect(rootPackage.scripts['test:e2e']).toBe('playwright test')
    })

    it('discovers e2e/ on both the Desktop and Mobile projects', () => {
        expect(playwrightConfig).toContain("testDir: './e2e'")
        expect(playwrightConfig).not.toContain('testIgnore')
        expect(playwrightConfig).toContain("name: 'Desktop'")
        expect(playwrightConfig).toContain("name: 'Mobile'")

        const specs = readdirSync(resolve(repoRoot, 'e2e')).filter((file) => file.endsWith('.spec.ts'))
        for (const spec of REQUIRED_SPECS) {
            expect(specs).toContain(`${spec}.spec.ts`)
            expect(existsSync(resolve(repoRoot, 'e2e', `${spec}.spec.ts`))).toBe(true)
        }
    })

    it('reuses the prebuilt standalone bundle the frontend job produced', () => {
        const frontend = jobBlock(workflow, 'frontend')
        expect(frontend).toContain('name: standalone-frontend-dist')
        expect(frontend).toContain('if-no-files-found: error')

        const job = jobBlock(workflow, 'e2e-standalone')
        expect(job).toContain('actions/download-artifact@v4')
        expect(job).toContain('name: standalone-frontend-dist')
        expect(job).toContain('path: dist/frontend')
        expect(job).toContain('test -f dist/frontend/index.html')
        expect(job).not.toContain('docker compose')
        expect(job).not.toContain('PLAYWRIGHT_BASE_URL')
    })

    it('runs deterministically: serial workers, no accidental .only, localhost base URL', () => {
        expect(playwrightConfig).toContain('forbidOnly: !!process.env.CI')
        expect(playwrightConfig).toContain('workers: process.env.CI ? 1 : undefined')
        expect(playwrightConfig).toContain("baseURL: 'http://127.0.0.1:4173'")
        expect(playwrightConfig).toContain('reuseExistingServer: !process.env.CI')
        expect(jobBlock(workflow, 'e2e-standalone')).toContain("CI: 'true'")
    })

    it('documents both E2E jobs as required status checks', () => {
        expect(docs).toContain('Playwright E2E (Desktop & Mobile)')
        expect(docs).toContain('Playwright E2E Standalone Suites (Desktop & Mobile)')
    })

    it('keeps the existing unit, Rust and container gates intact', () => {
        const frontend = jobBlock(workflow, 'frontend')
        expect(frontend).toContain('run: npm run lint')
        expect(frontend).toContain('run: npm run typecheck')
        expect(frontend).toContain('run: npm run test')
        expect(frontend).toContain('run: npm run build')
        expect(jobBlock(workflow, 'rust')).toContain('cargo test --workspace')
        expect(jobBlock(workflow, 'container-build')).toContain('docker build -t kanegrowth:ci .')
        expect(workflow).toContain(
            'needs: [lint-workflows, frontend, rust, e2e, e2e-standalone, container-build]'
        )
    })
})
