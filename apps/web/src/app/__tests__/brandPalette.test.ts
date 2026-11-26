import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// AC3/AC4 palette guard: the app is themed green + gold, and the violet palette must not creep
// back into production source. The legacy violet hexes are encoded here *without* a leading `#`
// and joined at runtime, so this file itself never contains a greppable violet hex value (the
// repository-wide smoke grep in the plan's manual protocol scans every file under `src/`).

const testDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testDir, '../../..')
const srcRoot = resolve(projectRoot, 'src')

const LEGACY_HEXES = [
    'a855f7',
    '9333ea',
    'c084fc',
    '7c3aed',
    'd8b4fe',
    'c4b5fd',
    'b975f9',
    'faf5ff',
    '6366f1',
    '14121c',
].map((hex) => '#' + hex)

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html'])

const productionFiles = (dir: string): string[] => {
    const files: string[] = []

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
            // Skip test directories: this guard is about production source.
            if (entry.name === '__tests__' || entry.name === 'test') continue
            files.push(...productionFiles(fullPath))
        } else if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name))) {
            files.push(fullPath)
        }
    }

    return files
}

const sourceFiles = productionFiles(srcRoot)
const relativePath = (file: string): string => file.slice(projectRoot.length + 1)

describe('brand palette', () => {
    it('declares green and gold theme tokens with no violet hex values in app source', () => {
        const indexCss = readFileSync(resolve(srcRoot, 'index.css'), 'utf-8')

        expect(indexCss).toContain('--color-accent: #d4af37')
        expect(indexCss).toContain('--color-page: #0e1512')
        expect(indexCss).toContain('--color-on-accent: #16130a')

        const offendingFiles = sourceFiles
            .filter((file) => {
                const source = readFileSync(file, 'utf-8').toLowerCase()
                return LEGACY_HEXES.some((hex) => source.includes(hex))
            })
            .map(relativePath)

        expect(offendingFiles).toEqual([])
    })

    it('leaves no violet utility classes in production source', () => {
        const violetUtilityClass = /(text|bg|border|ring|from|to)-(violet|purple|fuchsia)-/i

        const offendingClasses = sourceFiles
            .filter((file) => violetUtilityClass.test(readFileSync(file, 'utf-8')))
            .map(relativePath)

        expect(offendingClasses).toEqual([])
    })
})
