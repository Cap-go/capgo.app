import { describe, expect, it, vi } from 'vitest'
import { ChannelAlreadyExistsError } from '../supabase/functions/_backend/utils/channel_insert.ts'

const { events, query } = vi.hoisted(() => ({ events: [] as string[], query: vi.fn() }))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()),
  authPrincipal: () => ({ role: 'authenticated' }),
  // Mirrors withPgTransaction: COMMIT when the callback resolves, ROLLBACK when it throws.
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => {
    try {
      const result = await run({ query })
      events.push('commit')
      return result
    }
    catch (error) {
      events.push('rollback')
      throw error
    }
  },
}))

const { updateOrCreateChannel } = await import('../supabase/functions/_backend/utils/supabase.ts')

function context() {
  return { get: vi.fn((key: string) => key === 'auth' ? { authType: 'apikey', userId: 'user-test' } : 'request-id') } as never
}

const insert = { app_id: 'com.test.app', name: 'pr-1', created_by: 'user-test', owner_org: 'org-test', public: true }

describe('updateOrCreateChannel insert conflict', () => {
  it('rolls back insert-trigger writes when the channel already exists', async () => {
    // BEFORE INSERT triggers (normalize_public_channel_overlap) fire before ON CONFLICT skips the row.
    query.mockResolvedValueOnce({ rows: [{ row: { id: '42', version: null, rollout_version: null, public: false, paused_at: null, inserted: false } }] })
    await expect(updateOrCreateChannel(context(), insert as never, null)).rejects.toBeInstanceOf(ChannelAlreadyExistsError)
    expect(events).toEqual(['rollback'])
  })

  it('commits a new channel', async () => {
    events.length = 0
    query.mockResolvedValueOnce({ rows: [{ row: { id: '77', version: null, rollout_version: null, public: true, paused_at: null, inserted: true } }] })
    await expect(updateOrCreateChannel(context(), insert as never, null)).resolves.toEqual({ data: { id: 77 }, error: null })
    expect(events).toEqual(['commit'])
  })
})
