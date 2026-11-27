import type { BuildVariant } from '../src/build/variants'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const selectMock = mock(async (_opts: unknown): Promise<unknown> => '26.2')
const logMock = { info: mock(() => {}), warn: mock(() => {}), message: mock(() => {}) }
mock.module('@clack/prompts', () => ({ select: selectMock, isCancel: (value: unknown) => value === CANCEL, log: logMock }))
mock.module('../src/utils', () => ({
  findSavedKey: () => 'saved-key',
  createCapgoClient: async (apikey: string) => ({ apiHost: 'https://api.capgo.app', apikey }),
}))

const CANCEL = Symbol('cancel')
const { fetchBuildVariants, formatBuildVariant, listBuildVariantsCommand, promptXcodeVersion, selectableXcodeVersions } = await import('../src/build/variants')

const mac: BuildVariant = { platform: 'ios', id: 'xcode-26.2-macos-26.1', xcode_version: '26.2', macos_version: '26.1', runners: 3, online: 2, default: true }
const newMac: BuildVariant = { platform: 'ios', id: 'xcode-27.1-macos-27.0', xcode_version: '27.1', macos_version: '27.0', runners: 1, online: 1, default: false }
const oldMac: BuildVariant = { platform: 'ios', id: 'xcode-26.2-macos-15.6', xcode_version: '26.2', macos_version: '15.6', runners: 1, online: 0, default: true }

const realFetch = globalThis.fetch
function respondWith(body: unknown, status = 200) {
  const fetchMock = mock(async () => new Response(JSON.stringify(body), { status }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('build variants', () => {
  beforeEach(() => {
    selectMock.mockClear()
    selectMock.mockImplementation(async () => '26.2')
    logMock.info.mockClear()
    logMock.warn.mockClear()
    logMock.message.mockClear()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('formats a variant with its machine and availability', () => {
    expect(formatBuildVariant(mac)).toBe('Xcode 26.2 · macOS 26.1 · 2/3 online · default')
    expect(formatBuildVariant(newMac)).toBe('Xcode 27.1 · macOS 27.0 · 1/1 online')
    expect(formatBuildVariant(oldMac)).toBe('Xcode 26.2 · macOS 15.6 · offline · default')
  })

  it('groups variants by Xcode version, keeping the builder order', () => {
    expect(selectableXcodeVersions([newMac, mac, oldMac]).map(choice => [choice.xcodeVersion, choice.variants.length])).toEqual([
      ['27.1', 1],
      ['26.2', 2],
    ])
  })

  it('reads the list from the Capgo API with the API key', async () => {
    const fetchMock = respondWith({ default_xcode_major: '26', variants: [mac] })
    const result = await fetchBuildVariants('https://api.capgo.app', 'key-1')
    expect(result).toEqual({ default_xcode_major: '26', variants: [mac] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.capgo.app/build/variants?platform=ios')
    expect((init.headers as Record<string, string>).capgkey).toBe('key-1')
  })

  it('drops variants whose Xcode is not a dotted version', async () => {
    respondWith({ default_xcode_major: '26', variants: [{ ...mac, xcode_version: '26; rm -rf ~' }, newMac] })
    expect((await fetchBuildVariants('https://api.capgo.app', 'key-1')).variants).toEqual([newMac])
  })

  it('surfaces API errors', async () => {
    respondWith({ error: 'service_unavailable', message: 'down' }, 503)
    await expect(fetchBuildVariants('https://api.capgo.app', 'key-1')).rejects.toThrow('Capgo API 503 service_unavailable: down')
  })

  describe('promptXcodeVersion', () => {
    it('returns undefined without prompting when the list cannot be read', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
      expect(await promptXcodeVersion('https://api.capgo.app', 'key-1')).toBeUndefined()
      expect(selectMock).not.toHaveBeenCalled()
    })

    it('returns undefined without prompting when fewer than two Xcode versions exist', async () => {
      respondWith({ default_xcode_major: '26', variants: [mac, oldMac] })
      expect(await promptXcodeVersion('https://api.capgo.app', 'key-1')).toBeUndefined()
      expect(selectMock).not.toHaveBeenCalled()
    })

    it('offers "any machine" first, then each Xcode, and returns the pick', async () => {
      respondWith({ default_xcode_major: '26', variants: [newMac, mac] })
      expect(await promptXcodeVersion('https://api.capgo.app', 'key-1')).toBe('26.2')
      const { options } = selectMock.mock.calls[0][0] as { options: Array<{ value: string }> }
      expect(options.map(option => option.value)).toEqual(['', '27.1', '26.2'])
    })

    it('returns the empty "any machine" choice unchanged', async () => {
      respondWith({ default_xcode_major: '26', variants: [newMac, mac] })
      selectMock.mockImplementation(async () => '')
      expect(await promptXcodeVersion('https://api.capgo.app', 'key-1')).toBe('')
    })

    it('cancels the build when the prompt is cancelled', async () => {
      respondWith({ default_xcode_major: '26', variants: [newMac, mac] })
      selectMock.mockImplementation(async () => CANCEL)
      await expect(promptXcodeVersion('https://api.capgo.app', 'key-1')).rejects.toThrow('Build cancelled')
    })
  })

  describe('listBuildVariantsCommand', () => {
    it('prints each variant and the default major', async () => {
      respondWith({ default_xcode_major: '26', variants: [newMac, mac] })
      await listBuildVariantsCommand({})
      expect(logMock.message.mock.calls.map(call => (call as unknown as [string])[0])).toEqual([
        `  ${formatBuildVariant(newMac)}`,
        `  ${formatBuildVariant(mac)}`,
      ])
      expect((logMock.info.mock.calls.at(-1) as unknown as [string])[0]).toContain('prefer Xcode 26')
    })

    it('prints JSON with --json', async () => {
      respondWith({ default_xcode_major: '26', variants: [mac] })
      const writes: string[] = []
      const realWrite = process.stdout.write
      process.stdout.write = ((chunk: string) => {
        writes.push(chunk)
        return true
      }) as typeof process.stdout.write
      try {
        await listBuildVariantsCommand({ json: true })
      }
      finally {
        process.stdout.write = realWrite
      }
      expect(JSON.parse(writes.join(''))).toEqual({ default_xcode_major: '26', variants: [mac] })
    })

    it('warns when no machine reports an Xcode', async () => {
      respondWith({ default_xcode_major: '26', variants: [] })
      await listBuildVariantsCommand({})
      expect(logMock.warn).toHaveBeenCalled()
    })

    it('rejects an unknown platform', async () => {
      await expect(listBuildVariantsCommand({ platform: 'windows' })).rejects.toThrow('--platform must be ios or android')
    })
  })
})
