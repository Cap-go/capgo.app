import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFallbackDigest } from '../supabase/functions/_backend/utils/changelog.ts'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/services/capgoApi', () => ({ invokeCapgoApi: mocks.invoke }))

let changelog: typeof import('../src/services/changelog')

beforeEach(async () => {
  vi.resetModules()
  mocks.invoke.mockReset()
  changelog = await import('../src/services/changelog')
})

afterEach(() => vi.restoreAllMocks())

const summary = {
  ...buildFallbackDigest('capacitor', 'ionic-team/capacitor', [], '8.0.0', '8.1.0', { platforms: [], features: [] }),
  releases: [],
  truncated: false,
}

describe('client changelog caching', () => {
  it('limits checks for a large dependency list to four requests and deduplicates identical packages', async () => {
    let active = 0
    let maximum = 0
    mocks.invoke.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return { data: { version: '8.1.0' }, error: null }
    })
    const names = Array.from({ length: 12 }, (_, index) => `example-native-plugin-${index}`)
    const results = await Promise.all([...names, names[0], names[1]].map(name => changelog.fetchLatestVersion('dependency', name)))
    expect(results).toEqual(Array.from({ length: 14 }, () => '8.1.0'))
    expect(maximum).toBe(4)
    expect(mocks.invoke).toHaveBeenCalledTimes(12)
    expect(mocks.invoke.mock.calls.every(([url]) => url.startsWith('private/changelog/dependency?'))).toBe(true)
  })

  it('canonicalizes summary inputs and expires the browser cache so edited notes can be checked again', async () => {
    mocks.invoke.mockResolvedValue({ data: { ...summary, aiGenerated: true }, error: null })
    await changelog.fetchDigest({ product: 'capacitor', fromVersion: 'v8.0.0', toVersion: '8.1.0', locale: 'EN', context: { platforms: ['ios', 'android'], features: ['delta', 'encryption'] } })
    const input = { product: 'capacitor', fromVersion: '8.0.0', toVersion: '8.1.0', locale: 'en', context: { platforms: ['android', 'ios'], features: ['encryption', 'delta'] } } satisfies Parameters<typeof changelog.fetchDigest>[0]
    await changelog.fetchDigest(input)
    expect(mocks.invoke).toHaveBeenCalledOnce()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000)
    await changelog.fetchDigest(input)
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('backs off for a minute on fallback summaries and then tries again without retrying a paid call', async () => {
    mocks.invoke.mockResolvedValue({ data: summary, error: null })
    const input = { product: 'capacitor', fromVersion: '8.0.0', toVersion: '8.1.0' } satisfies Parameters<typeof changelog.fetchDigest>[0]
    await changelog.fetchDigest(input)
    await changelog.fetchDigest(input)
    expect(mocks.invoke).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledWith('private/changelog/digest', expect.objectContaining({ retries: 0 }))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await changelog.fetchDigest(input)
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })
})
