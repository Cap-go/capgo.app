import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBundleUrl, getManifestUrl } from '../supabase/functions/_backend/plugin_runtime/utils/downloadUrl.ts'

const state = vi.hoisted(() => ({ epoch: 'test-download-epoch' as string | null, runtime: 'workerd' }))
const signedUrl = vi.hoisted(() => vi.fn(async () => 'https://storage.example.com/direct-signed-url'))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({ get servingRegionReaderEpoch() { return state.epoch } }))
vi.mock('hono/adapter', () => ({ getRuntimeKey: () => state.runtime }))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/s3.ts', () => ({ s3: { getSignedUrl: signedUrl } }))
const key = 'orgs/example/apps/com.example.delivery/bundle.zip'
const app = new Hono()
app.get('/', async c => c.json({
  url: await getBundleUrl(c, key, 'fake-device', 'checksum'),
  manifest: getManifestUrl(c, 123, [{ s3_path: key, file_name: 'index.html', file_hash: 'fake-hash' }], 'fake-device'),
}))
afterEach(() => { state.epoch = 'test-download-epoch'; state.runtime = 'workerd'; signedUrl.mockClear() })
describe('enforcing download URLs', () => {
  it.each(['workerd', 'deno'])('keeps %s zip and manifest URLs behind the current-policy file ingress', async (runtime) => {
    state.runtime = runtime
    const result = await (await app.request('https://updates.example.com/', undefined, { PLUGIN_FILE_DOWNLOAD_BASE_URL: 'https://files.example.com/files/read/attachments/' })).json()
    expect(result).toMatchObject({
      url: `https://files.example.com/files/read/attachments/${key}?key=checksum&device_id=fake-device`,
      manifest: [{ download_url: `https://files.example.com/files/read/attachments/${key}?key=123&device_id=fake-device` }],
    })
    expect(signedUrl).not.toHaveBeenCalled()
  })
  it('keeps legacy Deno URLs unchanged while enforcement is disabled', async () => {
    state.epoch = null
    state.runtime = 'deno'
    const result = await (await app.request('https://updates.example.com/', undefined, { PLUGIN_FILE_DOWNLOAD_BASE_URL: 'https://files.example.com/files/read/attachments/' })).json()
    expect(result).toMatchObject({ url: 'https://storage.example.com/direct-signed-url' })
    expect(signedUrl).toHaveBeenCalledOnce()
  })
  it('fails unavailable instead of using an arbitrary custom API host when file ingress is missing', async () => {
    expect((await app.request('https://updates.example.com/')).status).toBe(503)
    expect(signedUrl).not.toHaveBeenCalled()
  })

})
