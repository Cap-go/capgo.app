import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prewarm } from '../supabase/functions/_backend/public/app/prewarm.ts'
import { PLUGIN_REGIONS } from '../supabase/functions/_backend/utils/pluginRegionTargets.ts'
import { checkPermission } from '../supabase/functions/_backend/utils/rbac.ts'

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: vi.fn() }))

const APP_ID = 'com.example.prewarm'
// An inherited PLUGIN_REGION_TARGETS would replace the production region list.
const inheritedTargets = process.env.PLUGIN_REGION_TARGETS

beforeEach(() => {
  delete process.env.PLUGIN_REGION_TARGETS
})

function context() {
  const raw = new Request(`https://api.capgo.app/app/${APP_ID}/prewarm`, { method: 'POST' })
  return { env: {}, req: { url: raw.url, raw, header: () => undefined }, get: () => 'req-prewarm-api', set: () => {}, json: (body: unknown) => Response.json(body) } as any
}

afterEach(() => {
  // Undo this file's stubs first, then put back what the parent environment had.
  vi.unstubAllEnvs()
  if (inheritedTargets === undefined)
    delete process.env.PLUGIN_REGION_TARGETS
  else
    process.env.PLUGIN_REGION_TARGETS = inheritedTargets
  vi.mocked(checkPermission).mockReset()
  vi.unstubAllGlobals()
})

describe('POST /app/:id/prewarm', () => {
  it('requires upload permission on the app', async () => {
    vi.mocked(checkPermission).mockResolvedValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(prewarm(context(), APP_ID)).rejects.toMatchObject({ status: 401 })
    expect(checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', { appId: APP_ID })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 503 when the server cannot call the regional workers', async () => {
    vi.mocked(checkPermission).mockResolvedValue(true)
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', '')
    await expect(prewarm(context(), APP_ID)).rejects.toMatchObject({ status: 503 })
  })

  it('rejects an invalid app id before checking permissions', async () => {
    await expect(prewarm(context(), 'not an app')).rejects.toMatchObject({ status: 400 })
    expect(checkPermission).not.toHaveBeenCalled()
  })

  it('returns one line per region for the app', async () => {
    vi.mocked(checkPermission).mockResolvedValue(true)
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('plugin.sa.'))
        throw new Error('network down')
      if (url.includes('plugin.oc.'))
        return Response.json({ results: [] }, { headers: { 'cf-placement': 'remote-SYD' } })
      if (url.includes('plugin.af.'))
        return Response.json({ results: [{ app_id: APP_ID, revision: null, cached: 0, skipped: 'disabled' }] }, { headers: { 'cf-placement': 'remote-JNB' } })
      // Japan without cf-placement: the worker's own measurement still pins it.
      if (url.includes('plugin.jp.'))
        return Response.json({ colo: 'LHR', ran_in: 'NRT', results: [{ app_id: APP_ID, revision: '7', cached: 3 }] })
      return Response.json({ results: [{ app_id: APP_ID, revision: '7', cached: 3 }] }, { headers: { 'cf-placement': 'remote-XXX' } })
    }))
    const response = await prewarm(context(), APP_ID)
    const body = await response.json() as { app_id: string, regions: Record<string, unknown>[] }
    expect(body.app_id).toBe(APP_ID)
    expect(body.regions.map(region => region.region)).toEqual(PLUGIN_REGIONS.map(region => region.name))
    expect(body.regions.find(region => region.region === 'na')).toEqual({ region: 'na', status: 200, placement: 'remote-XXX', pinned: true, revision: '7', cached: 3, skipped: null, error: null })
    expect(body.regions.find(region => region.region === 'jp')).toMatchObject({ placement: 'remote-NRT', pinned: true })
    expect(body.regions.find(region => region.region === 'af')).toMatchObject({ skipped: 'disabled', cached: 0 })
    expect(body.regions.find(region => region.region === 'sa')).toMatchObject({ status: null, error: 'network down', cached: 0 })
    // HTTP 200 without this app's outcome is a failure, not an "already warm" result.
    expect(body.regions.find(region => region.region === 'oc')).toMatchObject({ status: 200, cached: 0, error: 'missing_result' })
  })
})
