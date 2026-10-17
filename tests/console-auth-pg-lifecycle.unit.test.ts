import { beforeEach, expect, it, vi } from 'vitest'
import { createConsoleAuth } from '../supabase/functions/_backend/utils/console_auth.ts'

const { database, checkout, release, close } = vi.hoisted(() => ({
  database: { query: vi.fn(), end: vi.fn() },
  checkout: vi.fn(),
  release: vi.fn(),
  close: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => database,
  checkoutPgClient: checkout,
  releasePgClient: release,
  closeClient: close,
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => ({ CONSOLE_AUTH_URL: 'http://localhost', WEBAPP_URL: 'http://localhost', BETTER_AUTH_SECRET: 'fixture-secret-longer-than-thirty-two-characters', CONSOLE_TRUSTED_ORIGINS: '', ENV_NAME: 'fixture-local' })[key] ?? '',
}))
vi.mock('better-auth', () => ({ betterAuth: (options: any) => ({ options }) }))

beforeEach(() => {
  vi.clearAllMocks()
  checkout.mockResolvedValue(database)
})

it('serializes Kysely checkouts of the already-connected Hyperdrive client', async () => {
  const instance = await createConsoleAuth({} as any)
  const pool = instance.auth.options.database as any
  const first = await pool.connect()
  const secondPending = pool.connect()
  await Promise.resolve()
  expect(checkout).toHaveBeenCalledTimes(1)

  database.query.mockImplementation(function (this: unknown) {
    return this
  })
  expect(first.query('SELECT 1')).toBe(database)
  first.release()
  const second = await secondPending
  expect(checkout).toHaveBeenCalledTimes(2)
  expect(release).toHaveBeenCalledWith(database, database)
  second.release()
  await instance.close()
  expect(close).toHaveBeenCalledWith({}, database)
  expect(database.end).not.toHaveBeenCalled()
})

it('unblocks the next checkout after a failed connection acquisition', async () => {
  const instance = await createConsoleAuth({} as any)
  const pool = instance.auth.options.database as any
  checkout.mockRejectedValueOnce(new Error('connection unavailable'))
  await expect(pool.connect()).rejects.toThrow('connection unavailable')
  const connection = await pool.connect()
  connection.release()
  expect(checkout).toHaveBeenCalledTimes(2)
})
