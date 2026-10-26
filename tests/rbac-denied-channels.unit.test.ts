/**
 * getDeniedChannelIdsForPermission must return the channels where the caller's
 * effective channel permission is false, not only channels carrying an explicit
 * deny override. A principal whose app role grants app.read but not
 * channel.read_history (for example app_preview) is denied on every channel
 * that has no channel-level grant.
 */
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(async () => undefined),
  getDrizzleClient: vi.fn(() => ({ execute: executeMock })),
  getPgClient: vi.fn(async () => ({})),
}))

const { getDeniedChannelIdsForPermission } = await import('../supabase/functions/_backend/utils/rbac.ts')

const USER_ID = '00000000-0000-0000-0000-000000000001'
const APP_ID = 'com.example.app'

function context(auth: unknown) {
  return { get: (key: string) => (key === 'auth' ? auth : undefined) } as any
}

function executedQuery() {
  return new PgDialect().sqlToQuery(executeMock.mock.calls[0][0] as SQL)
}

function normalized(text: string) {
  return text.replace(/\s+/g, ' ')
}

describe('getDeniedChannelIdsForPermission', () => {
  beforeEach(() => {
    executeMock.mockReset()
  })

  it('evaluates the app-level grant and considers every channel of the app', async () => {
    executeMock.mockResolvedValue({ rows: [] })

    await getDeniedChannelIdsForPermission(context({ authType: 'jwt', userId: USER_ID }), 'channel.read_history', APP_ID)

    const { sql, params } = executedQuery()
    const text = normalized(sql)
    // App-level evaluation (no channel) so a role without the permission denies all channels.
    expect(text).toMatch(/public\.rbac_check_permission_direct\( \$\d+, \$\d+::uuid, a\.owner_org, a\.app_id, NULL::bigint, \$\d+ \) AS allowed/)
    // Candidates are all channels of the app, not only channels with an override row.
    expect(text).toContain('INNER JOIN public.channels ch ON ch.app_id = app_level.app_id')
    expect(text).not.toMatch(/FROM public\.channel_permission_overrides o INNER JOIN public\.channels/)
    // Channels with an override or a channel-scoped binding are evaluated individually.
    expect(text).toMatch(/THEN NOT public\.rbac_check_permission_direct\( \$\d+, \$\d+::uuid, ch\.owner_org, ch\.app_id, ch\.id, \$\d+ \) ELSE NOT app_level\.allowed END/)
    expect(text).toContain('rb.scope_type = public.rbac_scope_channel()')
    expect(params).toEqual(expect.arrayContaining(['channel.read_history', USER_ID, APP_ID]))
  })

  it('returns every channel the query denies, e.g. all channels for an app_preview principal', async () => {
    executeMock.mockResolvedValue({ rows: [{ id: '1' }, { id: 2 }, { id: '5' }] })

    const denied = await getDeniedChannelIdsForPermission(
      context({ authType: 'apikey', userId: USER_ID, apikey: { key: 'preview-key', rbac_id: 'rbac-1' } }),
      'channel.read_history',
      APP_ID,
    )

    expect(denied).toEqual(new Set([1, 2, 5]))
    expect(executedQuery().params).toContain('preview-key')
  })

  it('fails closed when the lookup errors', async () => {
    executeMock.mockRejectedValue(new Error('boom'))

    await expect(getDeniedChannelIdsForPermission(context({ authType: 'jwt', userId: USER_ID }), 'channel.read_history', APP_ID)).rejects.toMatchObject({ status: 403 })
  })

  it('requires an authenticated caller', async () => {
    await expect(getDeniedChannelIdsForPermission(context(undefined), 'channel.read_history', APP_ID)).rejects.toMatchObject({ status: 401 })
    expect(executeMock).not.toHaveBeenCalled()
  })
})
