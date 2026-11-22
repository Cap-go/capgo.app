import { afterEach, describe, expect, it, vi } from 'vitest'
import { prewarm } from '../supabase/functions/_backend/public/app/prewarm.ts'
import { PLUGIN_REGIONS } from '../supabase/functions/_backend/utils/pluginRegionTargets.ts'
import { checkPermission } from '../supabase/functions/_backend/utils/rbac.ts'

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: vi.fn() }))

const APP_ID = 'com.example.prewarm'

function context() {
  const raw = new Request(`https://api.capgo.app/app/${APP_ID}/prewarm`, { method: 'POST' })
  return { env: {}, req: { url: raw.url, raw, header: () => undefined }, get: () => 'req-prewarm-api', set: () => {}, json: (body: unknown) => Response.json(body) } as any
}

afterEach(() => {
  vi.mocked(checkPermission).mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
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
      if (url.includes('plugin.af.'))
        return Response.json({ placement: 'remote-JNB', results: [{ app_id: APP_ID, revision: null, cached: 0, skipped: 'disabled' }] })
      return Response.json({ placement: 'remote-XXX', results: [{ app_id: APP_ID, revision: '7', cached: 3 }] })
    }))
    const response = await prewarm(context(), APP_ID)
    const body = await response.json() as { app_id: string, regions: Record<string, unknown>[] }
    expect(body.app_id).toBe(APP_ID)
    expect(body.regions.map(region => region.region)).toEqual(PLUGIN_REGIONS.map(region => region.name))
    expect(body.regions.find(region => region.region === 'na')).toEqual({ region: 'na', status: 200, placement: 'remote-XXX', revision: '7', cached: 3, skipped: null, error: null })
    expect(body.regions.find(region => region.region === 'af')).toMatchObject({ skipped: 'disabled', cached: 0 })
    expect(body.regions.find(region => region.region === 'sa')).toMatchObject({ status: null, error: 'network down', cached: 0 })
  })
})
