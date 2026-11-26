import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Brand asset regression guard for the gold/green 金 KaneGrowth mark.
//
// The logo files are binaries, so a rename or a stray re-encode can silently change the artwork
// the brand depends on. These tests decode the real PNGs (no dependency: node:zlib only) and pin
// the measured anchors of the mark - the gold brush ring, the green pine, the gold 金 glyph and the
// transparent surround - plus the declared pixel sizes and the transparent icon background.
//
// The decoder intentionally supports only 8-bit RGBA (colour type 6), non-interlaced PNGs, which
// is what these assets are. Anything else throws a descriptive error instead of silently
// returning wrong pixels, so a format regression is fixed at the asset/script rather than skipped.

const testDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testDir, '../../..')

const assetPath = (relativePath: string): string => resolve(projectRoot, relativePath)

export interface Pixel {
    r: number
    g: number
    b: number
    a: number
}

interface DecodedPng {
    width: number
    height: number
    pixels: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    if (pb <= pc) return b
    return c
}

const decodePng = (relativePath: string): DecodedPng => {
    const buffer = readFileSync(assetPath(relativePath))

    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error(`${relativePath}: not a PNG (bad signature)`)
    }

    let width = 0
    let height = 0
    let bitDepth = 0
    let colorType = 0
    let interlace = 0
    const idatChunks: Buffer[] = []

    let offset = 8
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset)
        const type = buffer.toString('ascii', offset + 4, offset + 8)
        const data = buffer.subarray(offset + 8, offset + 8 + length)
        offset += 12 + length

        if (type === 'IHDR') {
            width = data.readUInt32BE(0)
            height = data.readUInt32BE(4)
            bitDepth = data.readUInt8(8)
            colorType = data.readUInt8(9)
            interlace = data.readUInt8(12)
        } else if (type === 'IDAT') {
            idatChunks.push(data)
        } else if (type === 'IEND') {
            break
        }
    }

    if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(
            `${relativePath}: expected an 8-bit RGBA PNG (colour type 6), got bit depth ${bitDepth}, colour type ${colorType}`,
        )
    }
    if (interlace !== 0) {
        throw new Error(`${relativePath}: interlaced PNGs are not supported`)
    }

    const raw = inflateSync(Buffer.concat(idatChunks))
    const bpp = 4
    const stride = width * bpp
    const pixels = new Uint8Array(width * height * bpp)

    for (let y = 0; y < height; y += 1) {
        const filter = raw.readUInt8(y * (stride + 1))
        const rowStart = y * (stride + 1) + 1
        const outStart = y * stride
        const prevStart = outStart - stride

        for (let x = 0; x < stride; x += 1) {
            const value = raw.readUInt8(rowStart + x)
            const left = x >= bpp ? pixels[outStart + x - bpp] : 0
            const up = y > 0 ? pixels[prevStart + x] : 0
            const upLeft = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0
            let decoded: number

            switch (filter) {
                case 0:
                    decoded = value
                    break
                case 1:
                    decoded = value + left
                    break
                case 2:
                    decoded = value + up
                    break
                case 3:
                    decoded = value + Math.floor((left + up) / 2)
                    break
                case 4:
                    decoded = value + paeth(left, up, upLeft)
                    break
                default:
                    throw new Error(
                        `${relativePath}: unsupported PNG filter type ${filter} on row ${y}`,
                    )
            }

            pixels[outStart + x] = decoded & 0xff
        }
    }

    return { width, height, pixels }
}

const pngCache = new Map<string, DecodedPng>()

const decode = (relativePath: string): DecodedPng => {
    const cached = pngCache.get(relativePath)
    if (cached) return cached

    const decoded = decodePng(relativePath)
    pngCache.set(relativePath, decoded)
    return decoded
}

const pngSize = (relativePath: string): { width: number; height: number } => {
    const { width, height } = decode(relativePath)
    return { width, height }
}

const pixelAt = (relativePath: string, x: number, y: number): Pixel => {
    const { width, pixels } = decode(relativePath)
    const index = (y * width + x) * 4
    return {
        r: pixels[index],
        g: pixels[index + 1],
        b: pixels[index + 2],
        a: pixels[index + 3],
    }
}

const alphaAt = (relativePath: string, x: number, y: number): number => pixelAt(relativePath, x, y).a

const isGold = (px: Pixel): boolean =>
    px.r > 130 && px.g > 95 && px.r - px.b > 60 && px.g - px.b > 40

const isGreen = (px: Pixel): boolean => px.g > 85 && px.g - px.r > 15 && px.g - px.b > 20

const glyphBox = { x: 400, y: 560, width: 240, height: 200 }

const countGold = (
    relativePath: string,
    box: { x: number; y: number; width: number; height: number },
): number => {
    const { pixels, width } = decode(relativePath)
    let count = 0

    for (let y = box.y; y < box.y + box.height; y += 1) {
        for (let x = box.x; x < box.x + box.width; x += 1) {
            const index = (y * width + x) * 4
            const px = {
                r: pixels[index],
                g: pixels[index + 1],
                b: pixels[index + 2],
                a: pixels[index + 3],
            }
            if (isGold(px)) count += 1
        }
    }

    return count
}

const logo = 'public/icons/kanegrowth_logo_gold_green_transparent.png'
const pwa512 = 'public/pwa-512.png'
const maskable = 'public/maskable-512.png'

describe('brand assets', () => {
    it('ships the single transparent 金 logo and derives every icon from it', () => {
        expect(pngSize(logo)).toEqual({ width: 1024, height: 1024 })
        expect(pngSize('src-tauri/icons/icon.png')).toEqual({ width: 512, height: 512 })

        // Transparent surround, gold brush ring, green pine, gold 金 glyph.
        expect(alphaAt(logo, 4, 4)).toBe(0)
        expect(isGold(pixelAt(logo, 509, 252))).toBe(true)
        expect(isGreen(pixelAt(logo, 642, 398))).toBe(true)
        expect(isGold(pixelAt(logo, 512, 600))).toBe(true)
        expect(countGold(logo, glyphBox)).toBeGreaterThan(5000)

        // Icons are derived on a transparent canvas at their declared sizes.
        expect(pngSize('public/pwa-192.png')).toEqual({ width: 192, height: 192 })
        expect(pngSize(pwa512)).toEqual({ width: 512, height: 512 })
        expect(pngSize('public/apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
        expect(pngSize(maskable)).toEqual({ width: 512, height: 512 })
        expect(alphaAt(pwa512, 4, 4)).toBe(0)
        expect(isGold(pixelAt(pwa512, 256, 256))).toBe(true)
        expect(alphaAt(maskable, 4, 4)).toBe(0)

        // The retired dark-badge variant is gone; one logo serves both themes.
        expect(existsSync(assetPath('public/icons/kanegrowth_logo_gold_green_dark_transparent.png'))).toBe(
            false,
        )
    })

    it('ships a multi-size favicon covering 16, 32 and 48 pixels', () => {
        const ico = readFileSync(assetPath('public/favicon.ico'))
        const iconWidths: number[] = []
        const count = ico.readUInt16LE(4)

        for (let i = 0; i < count; i += 1) {
            iconWidths.push(ico.readUInt8(6 + i * 16))
        }

        expect(ico.readUInt16LE(2)).toBe(1)
        expect(iconWidths).toEqual([16, 32, 48])
    })
})
