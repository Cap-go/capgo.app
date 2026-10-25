import { encode } from 'fast-png'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertStoreBundleId, fetchWebsiteIcon, nextWebsiteLiveVersionCode } from '../supabase/functions/_backend/utils/website_live_store.ts'

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  }
  catch (error) {
    return (error as { cause?: { error?: string } }).cause?.error
  }
  return undefined
}

function png(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encode({ width: size, height: size, data: new Uint8Array(size * size * 4).fill(255), channels: 4, depth: 8 }))
}

function stubSite(pages: Record<string, () => Response>) {
  const requested: string[] = []
  vi.stubGlobal('fetch', async (input: string) => {
    requested.push(input)
    const page = pages[input]
    if (!page)
      return new Response('missing', { status: 404 })
    return page()
  })
  return requested
}

/** A body without Content-Length, streamed in chunks. */
function chunked(bytes: number) {
  let sent = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close()
        return
      }
      const chunk = new Uint8Array(Math.min(1024 * 1024, bytes - sent))
      sent += chunk.byteLength
      controller.enqueue(chunk)
    },
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextWebsiteLiveVersionCode', () => {
  it('increases on every publish', () => {
    expect(nextWebsiteLiveVersionCode(0, null)).toBe(1)
    expect(nextWebsiteLiveVersionCode(1, 1)).toBe(2)
    expect(nextWebsiteLiveVersionCode(3, 7)).toBe(8)
  })

  it('counts older builds that did not record a number', () => {
    expect(nextWebsiteLiveVersionCode(4, null)).toBe(5)
    expect(nextWebsiteLiveVersionCode(4, '2')).toBe(5)
    expect(nextWebsiteLiveVersionCode(2, 'garbage')).toBe(3)
  })
})

describe('assertStoreBundleId', () => {
  it('rejects underscores for iOS only', () => {
    expect(assertStoreBundleId('com.my_company.app', 'android')).toBe('com.my_company.app')
    expect(errorCode(() => assertStoreBundleId('com.my_company.app', 'ios'))).toBe('invalid_bundle_id')
    expect(assertStoreBundleId('com.company.app2', 'ios')).toBe('com.company.app2')
    expect(errorCode(() => assertStoreBundleId('single', 'android'))).toBe('invalid_bundle_id')
  })
})

describe('fetchWebsiteIcon', () => {
  it('falls back to /apple-touch-icon.png when the homepage fails', async () => {
    const icon = png(512)
    stubSite({
      'https://app.example.com/': () => new Response('down', { status: 500 }),
      'https://app.example.com/apple-touch-icon.png': () => new Response(icon),
    })
    expect(await fetchWebsiteIcon('https://app.example.com/')).toEqual(icon)
  })

  it('falls back when the homepage streams past the size limit', async () => {
    const icon = png(512)
    stubSite({
      'https://app.example.com/': () => chunked(2 * 1024 * 1024),
      'https://app.example.com/apple-touch-icon.png': () => new Response(icon),
    })
    expect(await fetchWebsiteIcon('https://app.example.com/')).toEqual(icon)
  })

  it('skips undersized or broken PNG candidates', async () => {
    const icon = png(512)
    stubSite({
      'https://app.example.com/': () => new Response('<link rel="icon" sizes="1024x1024" href="/big.png"><link rel="icon" sizes="900x900" href="/broken.png"><link rel="icon" sizes="600x600" href="/ok.png">', { headers: { 'content-type': 'text/html' } }),
      'https://app.example.com/big.png': () => new Response(png(64)),
      'https://app.example.com/broken.png': () => new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5, 6])),
      'https://app.example.com/ok.png': () => new Response(icon),
    })
    expect(await fetchWebsiteIcon('https://app.example.com/')).toEqual(icon)
  })
})
