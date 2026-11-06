import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, PLUGIN_REGIONS } from '../supabase/functions/_backend/public/plugin_regions.ts'

const originalFetch = globalThis.fetch
const originalApiSecret = process.env.API_SECRET
const API_SECRET = 'test-secret'

interface PluginRegionVersionsResponse {
  status: string
  version?: string | null
  expectedVersion?: string
  regions: Array<{ version: string | null }>
  differences?: Array<{
    name: string
    version: string | null
    expectedVersion: string | null
    error: string | null
  }>
  unavailableRegions?: Array<{
    name: string
    error: string | null
  }>
}

function requestPluginRegions(path = '/') {
  return app.request(`http://local${path}`, {
    headers: {
      apisecret: API_SECRET,
    },
  })
}

function mockRegionFetch(versionByRegion: Partial<Record<typeof PLUGIN_REGIONS[number]['name'], string | null>>, failedRegions: Array<typeof PLUGIN_REGIONS[number]['name']> = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    const region = PLUGIN_REGIONS.find(item => item.url === url)

    if (!region)
      return new Response(null, { status: 404 })

    if (failedRegions.includes(region.name))
      throw new Error('network unavailable')

    const version = Object.hasOwn(versionByRegion, region.name) ? versionByRegion[region.name] : '1.0.0'
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }

    if (version)
      headers['x-worker-source'] = `${region.envName}-${version}`

    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers,
    })
  })
}

describe('plugin region versions', () => {
  beforeEach(() => {
    process.env.API_SECRET = API_SECRET
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch

    if (originalApiSecret === undefined)
      delete process.env.API_SECRET
    else
      process.env.API_SECRET = originalApiSecret
  })

  it('requires the API secret header', async () => {
    const response = await app.request('http://local/')
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain('Cannot find authorization')
  })

  it.each(['/', '/versions'])('returns ok from %s when every plugin region runs the same version', async (path) => {
    mockRegionFetch({})

    const response = await requestPluginRegions(path)
    const body = await response.json() as PluginRegionVersionsResponse

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'ok',
      version: '1.0.0',
    })
    expect(body.regions).toHaveLength(PLUGIN_REGIONS.length)
    expect(body.regions.every(region => region.version === '1.0.0')).toBe(true)
  })

  it('lists the differing regions when one plugin region is behind', async () => {
    mockRegionFetch({ jp: '0.9.9' })

    const response = await requestPluginRegions()
    const body = await response.json() as PluginRegionVersionsResponse

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      status: 'mismatch',
      expectedVersion: '1.0.0',
    })
    expect(body.differences).toEqual([
      expect.objectContaining({
        name: 'jp',
        version: '0.9.9',
        expectedVersion: '1.0.0',
        error: null,
      }),
    ])
  })

  it('returns indeterminate when no unique baseline version exists', async () => {
    mockRegionFetch({
      eu: '2.0.0',
      me: '2.0.0',
      hk: '2.0.0',
      jp: '2.0.0',
      as: '1.0.0',
      na: '1.0.0',
      af: '1.0.0',
      oc: '1.0.0',
      sa: null,
    })

    const response = await requestPluginRegions()
    const body = await response.json() as PluginRegionVersionsResponse

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'indeterminate',
      version: null,
    })
    expect(body.regions).toHaveLength(PLUGIN_REGIONS.length)
    expect(body.differences).toBeUndefined()
  })

  it('returns indeterminate when a region is unreachable but successful regions match', async () => {
    mockRegionFetch({}, ['jp'])

    const response = await requestPluginRegions()
    const body = await response.json() as PluginRegionVersionsResponse

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'indeterminate',
      version: '1.0.0',
    })
    expect(body.differences).toBeUndefined()
    expect(body.unavailableRegions).toEqual([
      expect.objectContaining({
        name: 'jp',
        error: 'network unavailable',
      }),
    ])
  })
})
