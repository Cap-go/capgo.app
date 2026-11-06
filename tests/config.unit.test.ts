import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/config.ts'
import { MIN_CLI_VERSION, MIN_CLI_VERSION_REASON } from '../supabase/functions/_backend/utils/cliMinVersion.ts'

const connect = vi.hoisted(() => vi.fn(() => {
  throw new Error('No database lookup expected')
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: connect, closeClient: vi.fn() }))
const notifyLegacyCliUpgrade = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../supabase/functions/_backend/utils/legacy_cli_notice.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/legacy_cli_notice.ts')>(),
  notifyLegacyCliUpgrade,
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_URL', 'https://testproject.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('get /private/config', () => {
  it('returns the CLI min version and why it is required', async () => {
    const response = await app.request('http://local/', { method: 'GET' })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.minCliVersion).toBe(MIN_CLI_VERSION)
    expect(body.minCliVersionReason).toBe(MIN_CLI_VERSION_REASON)
    expect(String(body.minCliVersionReason).length).toBeGreaterThan(0)
    expect(body.supbaseId).toBe('testproject')
    expect(body.useNewFinalizeBundleUpload).toBe(false)
    expect(connect).not.toHaveBeenCalled()
  })


  it('forwards CLI usage to the admin RPC binding without blocking the response', async () => {
    const record = vi.fn().mockRejectedValue(new Error('admin ingest unavailable'))
    // Run the background task inline, as the Worker's waitUntil would.
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const response = await app.request('http://local/', {
      method: 'GET',
      headers: { 'x-cli-version': '8.32.8', 'x-cli-command': 'bundle upload', 'x-cli-node': 'v22.0.0', 'x-cli-os': 'linux', 'capgo_api': '2025-10-01' },
    }, { ADMIN_CLI_USAGE: { record } })

    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith({
      cli_version: '8.32.8',
      command: 'bundle upload',
      node_version: 'v22.0.0',
      os_platform: 'linux',
      source: 'config',
      api_version: '2025-10-01',
      apikey_id: null,
      org_id: null,
    }))
    expect(connect).not.toHaveBeenCalled()
  })

  it('skips CLI usage work when the admin RPC binding is absent', async () => {
    const response = await app.request('http://local/', { method: 'GET', headers: { 'x-cli-version': '8.32.8', 'capgkey': 'fake-key' } })

    expect(response.status).toBe(200)
    expect(connect).not.toHaveBeenCalled()
  })

  it('asks the owner of an old CLI to upgrade, off the response path', async () => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const response = await app.request('http://local/', { method: 'GET', headers: { 'x-cli-version': '8.90.0', 'capgkey': 'fake-key' } })

    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(notifyLegacyCliUpgrade).toHaveBeenCalledWith(expect.anything(), { capgkey: 'fake-key', cliVersion: '8.90.0' }))
  })

  it('leaves current and anonymous CLIs alone', async () => {
    await app.request('http://local/', { method: 'GET', headers: { 'x-cli-version': '8.90.1', 'capgkey': 'fake-key' } })
    await app.request('http://local/', { method: 'GET', headers: { 'x-cli-version': '8.90.0' } })

    expect(notifyLegacyCliUpgrade).not.toHaveBeenCalled()
  })
})
