import type { BuildVariant } from '../src/build/variants'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { fetchBuildVariants, formatBuildVariant, selectableXcodeVersions } from '../src/build/variants'

const mac: BuildVariant = { platform: 'ios', id: 'xcode-26.2-macos-26.1', xcode_version: '26.2', macos_version: '26.1', backend: 'mac', runners: 3, online: 2, default: true }
const linux: BuildVariant = { platform: 'ios', id: 'xcode-27.1-linux', xcode_version: '27.1', macos_version: null, backend: 'linux', runners: 1, online: 1, default: false }
const oldMac: BuildVariant = { platform: 'ios', id: 'xcode-26.2-macos-15.6', xcode_version: '26.2', macos_version: '15.6', backend: 'mac', runners: 1, online: 0, default: true }

const realFetch = globalThis.fetch

describe('build variants', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('formats a variant with its machine and availability', () => {
    expect(formatBuildVariant(mac)).toBe('Xcode 26.2 · macOS 26.1 · 2/3 online · default')
    expect(formatBuildVariant(linux)).toBe('Xcode 27.1 · Linux builder · 1/1 online')
    expect(formatBuildVariant(oldMac)).toBe('Xcode 26.2 · macOS 15.6 · offline · default')
  })

  it('groups variants by Xcode version, keeping the builder order', () => {
    expect(selectableXcodeVersions([linux, mac, oldMac]).map(choice => [choice.xcodeVersion, choice.variants.length])).toEqual([
      ['27.1', 1],
      ['26.2', 2],
    ])
  })

  it('reads the list from the Capgo API with the API key', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ default_xcode_major: '26', variants: [mac] })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await fetchBuildVariants('https://api.capgo.app', 'key-1')
    expect(result).toEqual({ default_xcode_major: '26', variants: [mac] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.capgo.app/build/variants?platform=ios')
    expect((init.headers as Record<string, string>).capgkey).toBe('key-1')
  })

  it('surfaces API errors', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'service_unavailable', message: 'down' }), { status: 503 })) as unknown as typeof fetch
    await expect(fetchBuildVariants('https://api.capgo.app', 'key-1')).rejects.toThrow('Capgo API 503 service_unavailable: down')
  })
})
