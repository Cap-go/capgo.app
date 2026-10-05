import process from 'node:process'
import { expect, it, vi } from 'vitest'
import { main } from '../scripts/backfill-r2-inventory.ts'

const mocks = vi.hoisted(() => ({
  end: vi.fn(),
  progress: { lastKey: 'synthetic-private-object', token: 'synthetic-private-token', pages: 1, objects: 3, skipped: 1, complete: false },
}))
vi.mock('pg', () => ({ Client: class { connect = vi.fn(); end = mocks.end } }))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class { destroy = vi.fn() }, ListObjectsV2Command: class {} }))
vi.mock('../supabase/functions/_backend/utils/r2_inventory.ts', async importOriginal => ({
  ...await importOriginal<object>(),
  loadInventoryConfig: async () => ({ enabled: true, tombstoneDays: 7, minBatchMs: 500 }),
}))
vi.mock('../scripts/r2_inventory/scan.ts', async importOriginal => ({
  ...await importOriginal<object>(),
  scanInventory: async (_db: unknown, _list: unknown, _options: unknown, _config: unknown, onProgress: (progress: typeof mocks.progress) => void) => {
    onProgress(mocks.progress)
    return mocks.progress
  },
}))

it('reports useful CLI progress without exposing object keys or continuation tokens', async () => {
  const originalArgs = process.argv
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.argv = ['bun', 'backfill-r2-inventory.ts', '--bucket', 'synthetic-inventory-bucket']
  vi.stubEnv('R2_INVENTORY_DATABASE_URL', 'postgresql://synthetic@127.0.0.1/inventory')
  vi.stubEnv('R2_ENDPOINT', 'https://synthetic-fixture.r2.cloudflarestorage.com')
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-access-key')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-secret')
  try {
    await main()
    const stdout = log.mock.calls.map(call => String(call[0])).join('\n')
    expect(stdout).not.toContain(mocks.progress.lastKey)
    expect(stdout).not.toContain(mocks.progress.token)
    expect(log.mock.calls.map(call => JSON.parse(String(call[0])))).toContainEqual(expect.objectContaining({ pages: 1, objects: 3, skipped: 1 }))
    expect(mocks.end).toHaveBeenCalledTimes(1)
  }
  finally {
    process.argv = originalArgs
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }
})
