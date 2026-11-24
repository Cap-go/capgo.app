import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app as files } from '../supabase/functions/_backend/files/files.ts'

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({ servingRegionReaderEpoch: 'test-shared-file-epoch' }))
const app = new Hono()
app.route('/files', files)
app.route('/private/files', files)
app.route('/functions/v1/files', files)
afterEach(() => vi.unstubAllGlobals())

describe('shared file handler delivery admission', () => {
  it.each(['/files', '/private/files', '/functions/v1/files'])('gates %s before cache, storage fallback or database access', async (prefix) => {
    const fetcher = vi.fn(() => { throw new Error('No upstream allowed') })
    const match = vi.fn(() => { throw new Error('No cache allowed') })
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('caches', { default: { match } })
    const get = vi.fn(async () => ({ json: async () => ({ f: 1, app_id: 'com.example.files', generation: '2', policy: { regions: ['NA'], mode: 'route' } }) }))
    const key = 'orgs/example/apps/com.example.files/delta/index.html'
    const req = new Request(`https://updates.example.com${prefix}/read/attachments/${encodeURIComponent(key)}?app_id=com.example.other`)
    Object.defineProperty(req, 'cf', { value: { colo: 'CDG' } })
    expect((await app.fetch(req, { PLUGIN_STATE_POINTERS: { get } })).status).toBe(403)
    expect(get).toHaveBeenCalledWith('sr1:com.example.files')
    expect(fetcher).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })
})
