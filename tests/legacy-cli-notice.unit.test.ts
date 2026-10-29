import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkKey: vi.fn(),
  sendNotifOrgCached: vi.fn(),
  rows: [] as Array<{ email: string, orgId: string }>,
  getPgClient: vi.fn(async () => ({})),
  closeClient: vi.fn(async () => {}),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ checkKey: mocks.checkKey, supabaseAdmin: vi.fn(() => ({})) }))
vi.mock('../supabase/functions/_backend/utils/notifications.ts', () => ({ sendNotifOrgCached: mocks.sendNotifOrgCached }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => {
  const query = { from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query, limit: async () => mocks.rows }
  return { getPgClient: mocks.getPgClient, closeClient: mocks.closeClient, getDrizzleClient: () => ({ select: () => query }) }
})

const { FIRST_API_ONLY_CLI, isLegacySdkCli, LEGACY_CLI_CUTOFF, LEGACY_CLI_UPGRADE_EVENT, notifyLegacyCliUpgrade } = await import('../supabase/functions/_backend/utils/legacy_cli_notice.ts')

const context = { get: () => 'request-id', env: {} } as any

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BENTO_PUBLISHABLE_KEY', 'pk_live')
  vi.stubEnv('BENTO_SECRET_KEY', 'sk_live')
  vi.stubEnv('BENTO_SITE_UUID', 'site_live')
  mocks.rows = [{ email: 'owner@example.com', orgId: '00000000-0000-0000-0000-000000000001' }]
  mocks.checkKey.mockResolvedValue({ user_id: '00000000-0000-0000-0000-0000000000aa' })
  mocks.sendNotifOrgCached.mockResolvedValue(true)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isLegacySdkCli', () => {
  it.each([
    ['8.90.0', true],
    ['8.42.3', true],
    ['7.0.0', true],
    [FIRST_API_ONLY_CLI, false],
    ['8.98.2', false],
    ['9.0.0', false],
    ['', false],
    ['not-a-version', false],
  ])('%s → %s', (version, expected) => {
    expect(isLegacySdkCli(version)).toBe(expected)
  })
})

describe('notifyLegacyCliUpgrade', () => {
  it('emails the API key owner once a week with the cutoff', async () => {
    await notifyLegacyCliUpgrade(context, { capgkey: 'key', cliVersion: '8.90.0' })

    expect(mocks.sendNotifOrgCached).toHaveBeenCalledWith(
      context,
      LEGACY_CLI_UPGRADE_EVENT,
      expect.objectContaining({ cli_version: '8.90.0', minimum_cli_version: FIRST_API_ONLY_CLI, cutoff_date: LEGACY_CLI_CUTOFF }),
      '00000000-0000-0000-0000-000000000001',
      'user:00000000-0000-0000-0000-0000000000aa',
      '0 0 * * 1',
      'owner@example.com',
      expect.anything(),
    )
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })

  it('does nothing for current CLIs', async () => {
    await notifyLegacyCliUpgrade(context, { capgkey: 'key', cliVersion: FIRST_API_ONLY_CLI })
    expect(mocks.checkKey).not.toHaveBeenCalled()
  })

  it('does nothing without Bento', async () => {
    vi.stubEnv('BENTO_SITE_UUID', '')
    await notifyLegacyCliUpgrade(context, { capgkey: 'key', cliVersion: '8.90.0' })
    expect(mocks.checkKey).not.toHaveBeenCalled()
  })

  it('skips unknown keys and users without an org', async () => {
    mocks.checkKey.mockResolvedValueOnce(null)
    await notifyLegacyCliUpgrade(context, { capgkey: 'bad', cliVersion: '8.90.0' })
    mocks.rows = []
    await notifyLegacyCliUpgrade(context, { capgkey: 'key', cliVersion: '8.90.0' })
    expect(mocks.sendNotifOrgCached).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    mocks.sendNotifOrgCached.mockRejectedValueOnce(new Error('bento down'))
    await expect(notifyLegacyCliUpgrade(context, { capgkey: 'key', cliVersion: '8.90.0' })).resolves.toBeUndefined()
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })
})
