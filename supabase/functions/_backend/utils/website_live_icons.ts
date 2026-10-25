import type { DecodedPng } from 'fast-png'
import { decode, encode } from 'fast-png'
import { simpleError } from './hono.ts'

/**
 * Web2App icon pipeline: one uploaded PNG -> every icon the native template needs.
 *
 * Pure JS (fast-png only) so it runs the same on Cloudflare Workers and Supabase Deno.
 * Resampling works on premultiplied alpha with a separable area-average (box) filter for
 * downscales and bilinear for the (rare) upscale to 1024 from 512..1023 px sources.
 * Rows are filtered horizontally on demand into a small ring buffer, so memory stays at
 * O(output) besides the decoded source.
 */

export const WEBSITE_LIVE_ICON_MAX_BYTES = 5 * 1024 * 1024
export const WEBSITE_LIVE_ICON_MAX_DIMENSION = 4096
export const WEBSITE_LIVE_ICON_MIN_DIMENSION = 512

export interface WebsiteLiveIconSet {
  /** 1024x1024 RGB (no alpha), composited onto backgroundColor. App Store / iOS AppIcon. */
  ios1024: Uint8Array
  /** 192x192 RGB, composited onto backgroundColor. mipmap-xxxhdpi/ic_launcher.png */
  androidLegacy192: Uint8Array
  /** 192x192 RGBA, circle-masked (transparent outside). mipmap-xxxhdpi/ic_launcher_round.png */
  androidRound192: Uint8Array
  /** 432x432 RGBA, icon in the central 264x264 safe zone. mipmap-xxxhdpi/ic_launcher_foreground.png */
  androidForeground432: Uint8Array
  /** 512x512 RGB (no alpha). Google Play store listing icon. */
  playStore512: Uint8Array
  /** 256x256 RGBA preview for the console UI. */
  preview256: Uint8Array
  /** Normalized `#RRGGBB`. */
  backgroundColor: string
}

export interface WebsiteLiveIconOptions {
  /** `#RRGGBB` used behind transparent pixels and as the Android adaptive background. */
  backgroundColor: string
}

type Rgb = [number, number, number]

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/i

export function parseHexColor(color: string): Rgb {
  if (typeof color !== 'string' || !HEX_COLOR_REGEX.test(color))
    throw simpleError('invalid_background_color', 'Background color must be a #RRGGBB hex color', { backgroundColor: color })
  const value = Number.parseInt(color.slice(1), 16)
  return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
}

/** Cheap structural check before decoding: signature, IHDR dimensions, byte and pixel limits. */
export function assertPng(bytes: Uint8Array): { width: number, height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33)
    throw simpleError('invalid_icon', 'Icon must be a PNG image')
  if (bytes.byteLength > WEBSITE_LIVE_ICON_MAX_BYTES)
    throw simpleError('icon_too_large', 'Icon must be at most 5 MB', { size: bytes.byteLength, maxSize: WEBSITE_LIVE_ICON_MAX_BYTES })
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i])
      throw simpleError('invalid_icon', 'Icon must be a PNG image')
  }
  // First chunk must be IHDR (length 13).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
    throw simpleError('invalid_icon', 'Icon PNG header is invalid')
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0)
    throw simpleError('invalid_icon', 'Icon PNG has empty dimensions', { width, height })
  if (width > WEBSITE_LIVE_ICON_MAX_DIMENSION || height > WEBSITE_LIVE_ICON_MAX_DIMENSION)
    throw simpleError('icon_too_large', `Icon must be at most ${WEBSITE_LIVE_ICON_MAX_DIMENSION}x${WEBSITE_LIVE_ICON_MAX_DIMENSION} pixels`, { width, height })
  return { width, height }
}

/** Normalize any PNG color type / bit depth (palette, gray, gray+alpha, RGB, RGBA, 1..16 bit, tRNS) to RGBA8. */
function toRgba8(png: DecodedPng): Uint8Array {
  const { width, height, depth, channels, data } = png
  const pixelCount = width * height
  if (channels === 4 && depth === 8 && data instanceof Uint8Array && data.length === pixelCount * 4)
    return data
  const out = new Uint8Array(pixelCount * 4)

  if (png.palette) {
    const lut = new Uint8Array(256 * 4)
    for (let i = 0; i < png.palette.length && i < 256; i++) {
      const entry = png.palette[i]
      lut[i * 4] = entry[0]
      lut[i * 4 + 1] = entry[1]
      lut[i * 4 + 2] = entry[2]
      lut[i * 4 + 3] = entry.length > 3 ? entry[3] : 255
    }
    const rowBytes = Math.ceil((width * depth) / 8)
    const mask = (1 << depth) - 1
    let o = 0
    for (let y = 0; y < height; y++) {
      const rowStart = y * rowBytes
      for (let x = 0; x < width; x++) {
        let index: number
        if (depth === 8) {
          index = data[rowStart + x]
        }
        else {
          const bit = x * depth
          index = (data[rowStart + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask
        }
        const l = index * 4
        out[o++] = lut[l]
        out[o++] = lut[l + 1]
        out[o++] = lut[l + 2]
        out[o++] = lut[l + 3]
      }
    }
    return out
  }

  const transparency = png.transparency
  const hasKey = transparency !== undefined && transparency.length > 0

  if (depth < 8) {
    // Only grayscale may use sub-byte depths.
    const rowBytes = Math.ceil((width * depth) / 8)
    const mask = (1 << depth) - 1
    const scale = 255 / mask
    const key = hasKey ? transparency[0] : -1
    let o = 0
    for (let y = 0; y < height; y++) {
      const rowStart = y * rowBytes
      for (let x = 0; x < width; x++) {
        const bit = x * depth
        const raw = (data[rowStart + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask
        const v = Math.round(raw * scale)
        out[o++] = v
        out[o++] = v
        out[o++] = v
        out[o++] = raw === key ? 0 : 255
      }
    }
    return out
  }

  const shift = depth === 16 ? 8 : 0
  let i = 0
  let o = 0
  switch (channels) {
    case 1: {
      const key = hasKey ? transparency[0] : -1
      for (let p = 0; p < pixelCount; p++) {
        const raw = data[i++]
        const v = raw >> shift
        out[o++] = v
        out[o++] = v
        out[o++] = v
        out[o++] = raw === key ? 0 : 255
      }
      return out
    }
    case 2:
      for (let p = 0; p < pixelCount; p++) {
        const v = data[i++] >> shift
        out[o++] = v
        out[o++] = v
        out[o++] = v
        out[o++] = data[i++] >> shift
      }
      return out
    case 3: {
      const keyed = hasKey && transparency.length >= 3
      const kr = keyed ? transparency[0] : -1
      const kg = keyed ? transparency[1] : -1
      const kb = keyed ? transparency[2] : -1
      for (let p = 0; p < pixelCount; p++) {
        const r = data[i++]
        const g = data[i++]
        const b = data[i++]
        out[o++] = r >> shift
        out[o++] = g >> shift
        out[o++] = b >> shift
        out[o++] = r === kr && g === kg && b === kb ? 0 : 255
      }
      return out
    }
    case 4:
      for (let p = 0; p < pixelCount * 4; p++)
        out[p] = data[p] >> shift
      return out
    default:
      throw simpleError('invalid_icon', 'Unsupported PNG color type', { channels, depth })
  }
}

interface AxisWeights {
  start: Int32Array
  count: Int32Array
  weights: Float32Array
  maxTaps: number
}

/** Area-average weights for downscale (exact pixel coverage), bilinear for upscale. */
function axisWeights(inSize: number, outSize: number): AxisWeights {
  const scale = inSize / outSize
  const maxTaps = scale >= 1 ? Math.ceil(scale) + 1 : 2
  const start = new Int32Array(outSize)
  const count = new Int32Array(outSize)
  const weights = new Float32Array(outSize * maxTaps)
  for (let i = 0; i < outSize; i++) {
    const base = i * maxTaps
    if (scale >= 1) {
      const left = i * scale
      const right = Math.min(left + scale, inSize)
      const j0 = Math.floor(left)
      const j1 = Math.min(Math.ceil(right), inSize)
      start[i] = j0
      count[i] = j1 - j0
      let sum = 0
      for (let j = j0; j < j1; j++) {
        const w = Math.min(j + 1, right) - Math.max(j, left)
        weights[base + j - j0] = w
        sum += w
      }
      for (let k = 0; k < j1 - j0; k++)
        weights[base + k] /= sum
    }
    else {
      const x = Math.min(Math.max((i + 0.5) * scale - 0.5, 0), inSize - 1)
      const j0 = Math.floor(x)
      const t = x - j0
      start[i] = j0
      if (t === 0 || j0 + 1 >= inSize) {
        count[i] = 1
        weights[base] = 1
      }
      else {
        count[i] = 2
        weights[base] = 1 - t
        weights[base + 1] = t
      }
    }
  }
  return { start, count, weights, maxTaps }
}

/**
 * Resample the square crop (cropX, cropY, cropSize) of a straight RGBA8 image to outSize^2.
 * Returns premultiplied RGBA floats in 0..255.
 */
function resampleSquare(src: Uint8Array, srcWidth: number, cropX: number, cropY: number, cropSize: number, outSize: number): Float32Array {
  const wx = axisWeights(cropSize, outSize)
  const wy = axisWeights(cropSize, outSize)
  const rowLen = outSize * 4
  const ringSize = wy.maxTaps + 1
  const ring = new Float32Array(ringSize * rowLen)
  const ringRow = new Int32Array(ringSize).fill(-1)
  const out = new Float32Array(outSize * rowLen)
  const inv255 = 1 / 255

  const horizontalRow = (sy: number): number => {
    const slot = sy % ringSize
    const offset = slot * rowLen
    if (ringRow[slot] === sy)
      return offset
    ringRow[slot] = sy
    const rowBase = ((cropY + sy) * srcWidth + cropX) * 4
    for (let ox = 0; ox < outSize; ox++) {
      const s = wx.start[ox]
      const n = wx.count[ox]
      const wBase = ox * wx.maxTaps
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let p = rowBase + s * 4
      for (let k = 0; k < n; k++) {
        const alpha = src[p + 3]
        const wa = wx.weights[wBase + k] * alpha
        const wc = wa * inv255
        r += src[p] * wc
        g += src[p + 1] * wc
        b += src[p + 2] * wc
        a += wa
        p += 4
      }
      const o = offset + ox * 4
      ring[o] = r
      ring[o + 1] = g
      ring[o + 2] = b
      ring[o + 3] = a
    }
    return offset
  }

  for (let oy = 0; oy < outSize; oy++) {
    const s = wy.start[oy]
    const n = wy.count[oy]
    const wBase = oy * wy.maxTaps
    const outBase = oy * rowLen
    for (let k = 0; k < n; k++) {
      const w = wy.weights[wBase + k]
      const rowOffset = horizontalRow(s + k)
      for (let x = 0; x < rowLen; x++)
        out[outBase + x] += w * ring[rowOffset + x]
    }
  }
  return out
}

/** Composite premultiplied pixels onto an opaque background -> RGB8. */
function compositeOpaque(premul: Float32Array, pixelCount: number, bg: Rgb): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixelCount * 3)
  const inv255 = 1 / 255
  for (let p = 0, i = 0, o = 0; p < pixelCount; p++, i += 4, o += 3) {
    const rest = 1 - premul[i + 3] * inv255
    out[o] = premul[i] + bg[0] * rest
    out[o + 1] = premul[i + 1] + bg[1] * rest
    out[o + 2] = premul[i + 2] + bg[2] * rest
  }
  return out
}

/** Premultiplied floats -> straight RGBA8, written into `out` at (dx, dy) of a `outWidth`-wide canvas. */
function unpremultiplyInto(premul: Float32Array, size: number, out: Uint8ClampedArray, outWidth: number, dx: number, dy: number) {
  for (let y = 0; y < size; y++) {
    let i = y * size * 4
    let o = ((dy + y) * outWidth + dx) * 4
    for (let x = 0; x < size; x++, i += 4, o += 4) {
      const a = premul[i + 3]
      if (a <= 0.5 / 255) {
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
        out[o + 3] = 0
        continue
      }
      const k = 255 / a
      out[o] = premul[i] * k
      out[o + 1] = premul[i + 1] * k
      out[o + 2] = premul[i + 2] * k
      out[o + 3] = a
    }
  }
}

function encodeRgb(data: Uint8ClampedArray, size: number): Uint8Array {
  return encode({ width: size, height: size, data, channels: 3, depth: 8 })
}

function encodeRgba(data: Uint8ClampedArray, size: number): Uint8Array {
  return encode({ width: size, height: size, data, channels: 4, depth: 8 })
}

function circleMasked(premul: Float32Array, size: number, bg: Rgb): Uint8ClampedArray {
  const rgb = compositeOpaque(premul, size * size, bg)
  const out = new Uint8ClampedArray(size * size * 4)
  const radius = size / 2
  for (let y = 0; y < size; y++) {
    const dy = y + 0.5 - radius
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius
      // One-pixel anti-aliased edge.
      const coverage = Math.min(Math.max(radius - Math.sqrt(dx * dx + dy * dy) + 0.5, 0), 1)
      const p = y * size + x
      const o = p * 4
      if (coverage === 0)
        continue
      out[o] = rgb[p * 3]
      out[o + 1] = rgb[p * 3 + 1]
      out[o + 2] = rgb[p * 3 + 2]
      out[o + 3] = coverage * 255
    }
  }
  return out
}

export function generateWebsiteLiveIconSet(source: Uint8Array, opts: WebsiteLiveIconOptions): WebsiteLiveIconSet {
  const bg = parseHexColor(opts.backgroundColor)
  const backgroundColor = `#${opts.backgroundColor.slice(1).toUpperCase()}`
  const { width, height } = assertPng(source)
  const cropSize = Math.min(width, height)
  if (cropSize < WEBSITE_LIVE_ICON_MIN_DIMENSION)
    throw simpleError('icon_too_small', `Icon must be at least ${WEBSITE_LIVE_ICON_MIN_DIMENSION}x${WEBSITE_LIVE_ICON_MIN_DIMENSION} pixels`, { width, height })

  let decoded: DecodedPng
  try {
    decoded = decode(source)
  }
  catch (error) {
    throw simpleError('invalid_icon', 'Icon PNG could not be decoded', { width, height }, error)
  }
  if (decoded.width !== width || decoded.height !== height)
    throw simpleError('invalid_icon', 'Icon PNG could not be decoded', { width, height })
  const rgba = toRgba8(decoded)
  const cropX = (width - cropSize) >> 1
  const cropY = (height - cropSize) >> 1

  const master = resampleSquare(rgba, width, cropX, cropY, cropSize, 1024)
  const ios1024 = encodeRgb(compositeOpaque(master, 1024 * 1024, bg), 1024)

  // Smaller sizes come from the 1024 master when the source is larger (bounded CPU for 4096
  // sources), otherwise straight from the source crop to avoid filtering an upscaled image.
  let base = rgba
  let baseWidth = width
  let baseX = cropX
  let baseY = cropY
  let baseSize = cropSize
  if (cropSize > 1024) {
    const masterRgba = new Uint8ClampedArray(1024 * 1024 * 4)
    unpremultiplyInto(master, 1024, masterRgba, 1024, 0, 0)
    base = new Uint8Array(masterRgba.buffer)
    baseWidth = 1024
    baseX = 0
    baseY = 0
    baseSize = 1024
  }
  const resample = (size: number) => resampleSquare(base, baseWidth, baseX, baseY, baseSize, size)

  const playStore512 = encodeRgb(compositeOpaque(resample(512), 512 * 512, bg), 512)

  const premul192 = resample(192)
  const androidLegacy192 = encodeRgb(compositeOpaque(premul192, 192 * 192, bg), 192)
  const androidRound192 = encodeRgba(circleMasked(premul192, 192, bg), 192)

  // Adaptive icon foreground: 108dp canvas, 66dp safe zone that no launcher mask clips -> 264px centered in 432px.
  const foreground = new Uint8ClampedArray(432 * 432 * 4)
  unpremultiplyInto(resample(264), 264, foreground, 432, 84, 84)
  const androidForeground432 = encodeRgba(foreground, 432)

  const preview = new Uint8ClampedArray(256 * 256 * 4)
  unpremultiplyInto(resample(256), 256, preview, 256, 0, 0)
  const preview256 = encodeRgba(preview, 256)

  return { ios1024, androidLegacy192, androidRound192, androidForeground432, playStore512, preview256, backgroundColor }
}
