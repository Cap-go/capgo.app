import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runPluginStateBenchmark } from '../scripts/benchmark-plugin-state.ts'

const provider = vi.hoisted(() => ({ query: vi.fn(), seed: vi.fn() }))

vi.mock('./test-utils.ts', () => ({
  API_SECRET: 'local-test-secret',
  CLOUDFLARE_API_URL: 'http://127.0.0.1:8787',
  CLOUDFLARE_PLUGIN_URL: 'http://127.0.0.1:8788',
  POSTGRES_URL: 'postgresql://127.0.0.1:54322/postgres',
  executeSQL: provider.query,
  resetAndSeedAppData: provider.seed,
  createAppVersions: vi.fn(),
  insertManifestRows: vi.fn(),
  makeBaseData: vi.fn(),
  resetAppData: vi.fn(),
  resetAppDataStats: vi.fn(),
}))

beforeEach(() => {
  provider.query.mockReset()
  provider.seed.mockReset().mockRejectedValue(new Error('fixture reached'))
})

describe('standalone plugin state benchmark prerequisites', () => {
  it.each([false, undefined])('fails before creating fixtures when sync is not enabled (%s)', async (enabled) => {
    provider.query.mockResolvedValue(enabled === undefined ? [] : [{ enabled }])
    await expect(runPluginStateBenchmark(5)).rejects.toThrow('CAPGO_PLUGIN_STATE_SYNC_ENABLED in local Vault')
    expect(provider.query).toHaveBeenCalledExactlyOnceWith('SELECT public.plugin_state_sync_enabled() AS enabled')
    expect(provider.seed).not.toHaveBeenCalled()
  })

  it('allows fixture creation after the database confirms sync is enabled', async () => {
    provider.query.mockResolvedValue([{ enabled: true }])
    await expect(runPluginStateBenchmark(5)).rejects.toThrow('fixture reached')
    expect(provider.query).toHaveBeenCalledOnce()
    expect(provider.seed).toHaveBeenCalledOnce()
  })
})
