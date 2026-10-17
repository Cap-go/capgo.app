import { decode, encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { assertPng, generateWebsiteLiveIconSet, parseHexColor } from '../supabase/functions/_backend/utils/website_live_icons.ts'

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  }
  catch (error) {
    return (error as { cause?: { error?: string } }).cause?.error
  }
  return undefined
}

/** RGBA image: opaque red square in the middle half, transparent elsewhere. */
function makeRgba(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= width / 4 && x < (width * 3) / 4 && y >= height / 4 && y < (height * 3) / 4
      const o = (y * width + x) * 4
      if (inside) {
        data[o] = 255
        data[o + 3] = 255
      }
    }
  }
  return encode({ width, height, data, channels: 4, depth: 8 })
}

function pixel(png: ReturnType<typeof decode>, x: number, y: number): number[] {
  const o = (y * png.width + x) * png.channels
  return Array.from(png.data.slice(o, o + png.channels))
}

describe('website live icons', () => {
  it('parses hex colors', () => {
    expect(parseHexColor('#0a1B2c')).toEqual([10, 27, 44])
    expect(errorCode(() => parseHexColor('red'))).toBe('invalid_background_color')
    expect(errorCode(() => parseHexColor('#fff'))).toBe('invalid_background_color')
  })

  it('validates png headers', () => {
    expect(assertPng(makeRgba(600, 520))).toEqual({ width: 600, height: 520 })
    expect(errorCode(() => assertPng(new Uint8Array(100)))).toBe('invalid_icon')
    expect(errorCode(() => assertPng(new Uint8Array(10)))).toBe('invalid_icon')
    const big = makeRgba(16, 16)
    const view = new DataView(big.buffer, big.byteOffset)
    view.setUint32(16, 5000)
    expect(errorCode(() => assertPng(big))).toBe('icon_too_large')
    const huge = new Uint8Array(5 * 1024 * 1024 + 1)
    huge.set(makeRgba(16, 16))
    expect(errorCode(() => assertPng(huge))).toBe('icon_too_large')
  })

  it('rejects small icons', () => {
    expect(errorCode(() => generateWebsiteLiveIconSet(makeRgba(1024, 500), { backgroundColor: '#ffffff' }))).toBe('icon_too_small')
  })

  it('produces every output with the right size and channels', () => {
    const set = generateWebsiteLiveIconSet(makeRgba(1200, 1024), { backgroundColor: '#00ff00' })
    expect(set.backgroundColor).toBe('#00FF00')
    const expectations: [Uint8Array, number, number][] = [
      [set.ios1024, 1024, 3],
      [set.androidLegacy192, 192, 3],
      [set.androidRound192, 192, 4],
      [set.androidForeground432, 432, 4],
      [set.playStore512, 512, 3],
      [set.preview256, 256, 4],
    ]
    for (const [bytes, size, channels] of expectations) {
      const png = decode(bytes)
      expect(png.width).toBe(size)
      expect(png.height).toBe(size)
      expect(png.channels).toBe(channels)
      expect(png.depth).toBe(8)
    }

    const ios = decode(set.ios1024)
    expect(pixel(ios, 512, 512)).toEqual([255, 0, 0])
    expect(pixel(ios, 5, 5)).toEqual([0, 255, 0])

    const round = decode(set.androidRound192)
    expect(pixel(round, 0, 0)[3]).toBe(0)
    expect(pixel(round, 96, 96)).toEqual([255, 0, 0, 255])
    expect(pixel(round, 96, 4)).toEqual([0, 255, 0, 255])

    const fg = decode(set.androidForeground432)
    expect(pixel(fg, 10, 10)[3]).toBe(0)
    // Icon lives in 72..360; the red square is its middle half: 144..288.
    expect(pixel(fg, 216, 216)).toEqual([255, 0, 0, 255])
    expect(pixel(fg, 100, 100)[3]).toBe(0)

    const preview = decode(set.preview256)
    expect(pixel(preview, 128, 128)).toEqual([255, 0, 0, 255])
    expect(pixel(preview, 2, 2)[3]).toBe(0)
  })

  it('area-averages a checkerboard to mid gray', () => {
    const size = 2048
    const data = new Uint8Array(size * size * 3)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = (x + y) % 2 === 0 ? 255 : 0
        data.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3)
      }
    }
    const set = generateWebsiteLiveIconSet(encode({ width: size, height: size, data, channels: 3, depth: 8 }), { backgroundColor: '#000000' })
    for (const bytes of [set.ios1024, set.playStore512, set.androidLegacy192]) {
      const png = decode(bytes)
      const [r] = pixel(png, png.width >> 1, png.height >> 1)
      expect(Math.abs(r - 128)).toBeLessThanOrEqual(1)
    }
  })

  it('normalizes palette, 16-bit and gray+alpha sources', () => {
    const size = 512
    const indices = new Uint8Array(size * size).fill(1)
    const palette = encode({ width: size, height: size, data: indices, channels: 1, depth: 8, palette: [[0, 0, 0, 0], [0, 0, 255, 255]] })
    expect(pixel(decode(generateWebsiteLiveIconSet(palette, { backgroundColor: '#ffffff' }).ios1024), 500, 500)).toEqual([0, 0, 255])

    const transparentPalette = encode({ width: size, height: size, data: new Uint8Array(size * size), channels: 1, depth: 8, palette: [[0, 0, 0, 0], [0, 0, 255, 255]] })
    expect(pixel(decode(generateWebsiteLiveIconSet(transparentPalette, { backgroundColor: '#ffffff' }).ios1024), 500, 500)).toEqual([255, 255, 255])

    const deep = new Uint16Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      deep[i * 4 + 1] = 65535
      deep[i * 4 + 3] = 65535
    }
    const png16 = encode({ width: size, height: size, data: deep, channels: 4, depth: 16 })
    expect(pixel(decode(generateWebsiteLiveIconSet(png16, { backgroundColor: '#000000' }).playStore512), 10, 10)).toEqual([0, 255, 0])

    const ga = new Uint8Array(size * size * 2)
    for (let i = 0; i < size * size; i++) {
      ga[i * 2] = 200
      ga[i * 2 + 1] = 128
    }
    const gray = encode({ width: size, height: size, data: ga, channels: 2, depth: 8 })
    const [r, g, b, a] = pixel(decode(generateWebsiteLiveIconSet(gray, { backgroundColor: '#000000' }).preview256), 10, 10)
    expect([r, g, b]).toEqual([200, 200, 200])
    expect(a).toBe(128)
  })

  it('generates the full set from a 2048 source quickly', () => {
    const size = 2048
    const data = new Uint8Array(size * size * 4)
    for (let i = 0; i < data.length; i++)
      data[i] = (i * 2654435761) >>> 24
    const source = encode({ width: size, height: size, data, channels: 4, depth: 8 })
    const start = performance.now()
    const set = generateWebsiteLiveIconSet(source, { backgroundColor: '#123456' })
    const elapsed = performance.now() - start
    console.log(`website live icon set from 2048x2048 RGBA: ${elapsed.toFixed(0)} ms`)
    expect(decode(set.ios1024).width).toBe(1024)
    expect(elapsed).toBeLessThan(3000)
  })
})
