import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockedModules = [
  '../supabase/functions/_backend/utils/hono.ts',
  '../supabase/functions/_backend/utils/pg.ts',
  '../supabase/functions/_backend/utils/plans.ts',
]

describe('cron_sync_sub resilience', () => {
  function setupCommonMocks(syncSubscriptionAndEvents: ReturnType<typeof vi.fn>) {
    vi.doMock('../supabase/functions/_backend/utils/hono.ts', () => ({
      BRES: { status: 'ok' },
      middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
      parseBody: async (c: { req: { json: () => Promise<unknown> } }) => await c.req.json(),
      simpleError: (errorCode: string, message: string, moreInfo: Record<string, unknown> = {}) => {
        throw new HTTPException(400, { message, cause: { error: errorCode, ...moreInfo } })
      },
    }))
    vi.doMock('../supabase/functions/_backend/utils/pg.ts', () => ({
      closeClient: vi.fn(),
      getDrizzleClient: vi.fn((client: { readOnly: boolean }) => ({
        execute: vi.fn(async () => {
          if (client.readOnly)
            throw Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code: '25006' })
          return { rows: [] }
        }),
      })),
      getPgClient: vi.fn((_c: unknown, readOnly = false) => ({ readOnly })),
    }))
    vi.doMock('../supabase/functions/_backend/utils/plans.ts', () => ({
      syncSubscriptionAndEvents,
    }))
  }

  async function runCronSyncSub(syncSubscriptionAndEvents: ReturnType<typeof vi.fn>, orgId: string) {
    setupCommonMocks(syncSubscriptionAndEvents)
    const { app: cronSyncSub } = await import('../supabase/functions/_backend/triggers/cron_sync_sub.ts')
    return cronSyncSub.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId }),
    })
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    mockedModules.forEach(path => vi.doUnmock(path))
    vi.resetModules()
  })

  it('allows subscription sync to write billing state without a primary read-only transaction', async () => {
    const syncSubscriptionAndEvents = vi.fn(async (_c: unknown, _orgId: string, db: { execute: (query: string) => Promise<unknown> }) => {
      await db.execute('UPDATE public.stripe_info SET is_good_plan = true WHERE customer_id = $1')
    })
    const response = await runCronSyncSub(syncSubscriptionAndEvents, 'org-writer')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(syncSubscriptionAndEvents).toHaveBeenCalledTimes(1)
    const { closeClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    expect(closeClient).toHaveBeenCalledOnce()
  })

  it('retries transient cron_sync_sub failures and succeeds', async () => {
    const syncSubscriptionAndEvents = vi.fn()
      .mockRejectedValueOnce({ status: 502, message: 'error code: 502' })
      .mockResolvedValueOnce(undefined)
    const response = await runCronSyncSub(syncSubscriptionAndEvents, 'org-retry')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(syncSubscriptionAndEvents).toHaveBeenCalledTimes(2)
  })

  it('skips stale cron_sync_sub jobs when the org no longer exists', async () => {
    const syncSubscriptionAndEvents = vi.fn().mockRejectedValue(
      new HTTPException(404, { message: 'Org not found', cause: { error: 'org_not_found' } }),
    )
    const response = await runCronSyncSub(syncSubscriptionAndEvents, 'org-missing')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'skipped', reason: 'org_not_found' })
    expect(syncSubscriptionAndEvents).toHaveBeenCalledTimes(1)
  })
})
