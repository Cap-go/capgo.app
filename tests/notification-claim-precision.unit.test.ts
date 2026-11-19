import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { Context } from 'hono'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDrizzleClient: vi.fn(),
  getPgClient: vi.fn(),
  closeClient: vi.fn(),
  logPgError: vi.fn(),
  trackBentoEvent: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getDrizzleClient: mocks.getDrizzleClient,
  getPgClient: mocks.getPgClient,
  closeClient: mocks.closeClient,
  logPgError: mocks.logPgError,
}))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  getDrizzleClient: mocks.getDrizzleClient,
  getPgClient: mocks.getPgClient,
  closeClient: mocks.closeClient,
  logPgError: mocks.logPgError,
}))
vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({ trackBentoEvent: mocks.trackBentoEvent }))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/bento.ts', () => ({ trackBentoEvent: mocks.trackBentoEvent }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))

const { getDrizzleClient } = await import('../supabase/functions/_backend/utils/pg.ts')
const api = await import('../supabase/functions/_backend/utils/notifications.ts')
const plugin = await import('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts')
const orgId = '00000000-0000-4000-8000-000000000001'
const eventName = 'org:test_notification'
const uniqId = 'precision-regression'
const previousTimestamp = '2026-01-01 00:00:00.123456+00'
const changedTimestamp = '2026-01-01 00:00:00.123457+00'
let database: PGlite
const connection = new Client()
const context = new Context(new Request('https://example.com/notifications'))

beforeAll(async () => {
  database = await PGlite.create()
  // Match the real PostgreSQL table, including its full microsecond precision.
  await database.exec(`CREATE TABLE public.notifications (
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    last_send_at timestamptz NOT NULL DEFAULT now(), total_send bigint NOT NULL DEFAULT 1,
    owner_org uuid NOT NULL, event varchar(255) NOT NULL, uniq_id varchar(255) NOT NULL,
    UNIQUE(owner_org, event, uniq_id)
  )`)
}, 30_000)

afterAll(async () => database?.close())
afterEach(() => vi.useRealTimers())
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.getPgClient.mockResolvedValue(connection)
  mocks.getDrizzleClient.mockReturnValue(drizzle({ client: database }))
  mocks.closeClient.mockResolvedValue(undefined)
  mocks.trackBentoEvent.mockResolvedValue(true)
  await database.exec("SET TIME ZONE 'UTC'; TRUNCATE public.notifications")
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T12:00:00.456Z'))
})

async function insert(timestamp = previousTimestamp) {
  await database.query(`INSERT INTO public.notifications(owner_org, event, uniq_id, last_send_at, total_send)
    VALUES ($1, $2, $3, $4::timestamptz, 3)`, [orgId, eventName, uniqId, timestamp])
}

async function current() {
  const result = await database.query<{ timestamp: string, count: number }>(
    'SELECT last_send_at::text AS timestamp, total_send::int AS count FROM public.notifications',
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]!
}

for (const [name, sendNotifOrg] of [['API', api.sendNotifOrg], ['plugin runtime', plugin.sendNotifOrg]] satisfies Array<[string, typeof api.sendNotifOrg]>) {
  describe(`${name} notification claims on PostgreSQL`, () => {
    const send = () => sendNotifOrg(context, eventName, {}, orgId, uniqId, '0 0 * * *', 'notifications@example.com', getDrizzleClient(connection))

    it.each([previousTimestamp, '2026-01-01 00:00:00.123+00'])('sends an unchanged due claim at %s', async (timestamp) => {
      await insert(timestamp)
      const sent = await send()
      expect(mocks.logPgError.mock.calls).toEqual([])
      expect(sent).toBe(true)
      expect(mocks.trackBentoEvent).toHaveBeenCalledOnce()
      expect(await current()).toEqual({ timestamp: '2026-02-01 12:00:00.456+00', count: 4 })
      expect(mocks.closeClient).toHaveBeenCalledOnce()
    })

    it.each(['false', 'reject'])('restores the exact previous timestamp when delivery returns %s', async (failure) => {
      await insert()
      if (failure === 'reject')
        mocks.trackBentoEvent.mockRejectedValueOnce(new Error('temporary test provider failure'))
      else
        mocks.trackBentoEvent.mockResolvedValueOnce(false)
      expect(await send()).toBe(false)
      expect(mocks.trackBentoEvent).toHaveBeenCalledOnce()
      expect(await current()).toEqual({ timestamp: previousTimestamp, count: 3 })
    })

    it.each(['success', 'false', 'reject'])('preserves the exact claim across reader and writer time zones on %s', async (outcome) => {
      await insert()
      await database.exec("SET TIME ZONE 'Asia/Kolkata'")
      mocks.getPgClient.mockImplementationOnce(async () => {
        await database.exec("SET TIME ZONE 'UTC'")
        return connection
      })
      if (outcome === 'false')
        mocks.trackBentoEvent.mockResolvedValueOnce(false)
      else if (outcome === 'reject')
        mocks.trackBentoEvent.mockRejectedValueOnce(new Error('temporary test provider failure'))
      expect(await send()).toBe(outcome === 'success')
      expect(mocks.trackBentoEvent).toHaveBeenCalledOnce()
      expect(await current()).toEqual(outcome === 'success'
        ? { timestamp: '2026-02-01 12:00:00.456+00', count: 4 }
        : { timestamp: previousTimestamp, count: 3 })
    })

    it('rejects a competing update within the same JavaScript millisecond', async () => {
      await insert()
      // Opening the write connection happens after the actual replica SELECT.
      mocks.getPgClient.mockImplementationOnce(async () => {
        await database.query('UPDATE public.notifications SET last_send_at = $1::timestamptz, total_send = 4', [changedTimestamp])
        return connection
      })
      expect(await send()).toBe(false)
      expect(mocks.trackBentoEvent).not.toHaveBeenCalled()
      expect(await current()).toEqual({ timestamp: changedTimestamp, count: 4 })
    })

    it('does not roll back over a newer claim after a provider failure', async () => {
      await insert()
      const replacementTimestamp = '2026-02-01 12:00:00.456001+00'
      mocks.trackBentoEvent.mockImplementationOnce(async () => {
        await database.query('UPDATE public.notifications SET last_send_at = $1::timestamptz, total_send = 5', [replacementTimestamp])
        return false
      })
      expect(await send()).toBe(false)
      expect(mocks.trackBentoEvent).toHaveBeenCalledOnce()
      expect(await current()).toEqual({ timestamp: replacementTimestamp, count: 5 })
    })

    it('preserves the existing ISO timestamp response when the cron window is not due', async () => {
      await insert('2026-02-01 11:00:00.123456+00')
      expect(await send()).toEqual({ sent: false, lastSendAt: '2026-02-01T11:00:00.123Z' })
      expect(mocks.trackBentoEvent).not.toHaveBeenCalled()
      expect(await current()).toEqual({ timestamp: '2026-02-01 11:00:00.123456+00', count: 3 })
    })
  })
}
