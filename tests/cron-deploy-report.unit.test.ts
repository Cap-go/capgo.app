import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/triggers/cron_email.ts'
import { MONTHLY_REPORT_BATCH_SQL, WEEKLY_REPORT_BATCH_SQL, WEEKLY_REPORT_SQL } from '../supabase/functions/_backend/utils/cron_email_stats.ts'
import { DEPLOY_REPORT_CONSUME_SQL, DEPLOY_REPORT_RELEASE_SQL, DEPLOY_REPORT_SELECT_SQL } from '../supabase/functions/_backend/utils/deploy_report.ts'

const mocks = vi.hoisted(() => ({
  queryJson: vi.fn(),
  query: vi.fn(),
  stats: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  sendWeekly: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => next(),
  parseBody: (c: { req: { json: () => Promise<unknown> } }) => c.req.json(),
  simpleError: (_code: string, message: string) => new Error(message),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: async () => ({ query: mocks.query }), closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({ queryJson: mocks.queryJson }))
vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({ readStatsVersion: mocks.stats }))
vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({ prepareEmailToOrgMembers: mocks.prepare, sendEmailToOrgMembers: mocks.sendWeekly }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/plans.ts', () => ({ findBestPlan: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ getCurrentPlanNameOrg: vi.fn(), getOrgExtraMau: vi.fn() }))

const deploy = {
  id: 123, app_id: 'com.example.report', owner_org: '00000000-0000-4000-8000-000000000001',
  version_id: 456, version_name: '2.0.0', channel_id: 789, channel_name: 'production',
  app_name: 'Example App', platform: 'ios', deployed_at: '2026-11-10T18:15:00.000Z',
}
const payload = {
  type: 'deploy_install_stats_v2', email: 'report@example.com', appId: deploy.app_id,
  deployId: deploy.id, reportClaimedAt: '2026-11-11T19:00:00.123456Z',
  orgId: 'stale-org', versionName: 'stale-version', versionId: 999,
  deployedAt: '2099-01-01T00:00:00Z', channelName: 'stale-channel', appName: 'stale-app',
}
const claim = [payload.deployId, payload.appId, payload.reportClaimedAt]
function run(overrides: Record<string, unknown> = {}) {
  return app.request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, ...overrides }) }, { VERSION_USAGE: {} })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.prepare.mockResolvedValue({ send: mocks.send })
  mocks.queryJson.mockResolvedValue([deploy])
  mocks.query.mockResolvedValue({ rows: [] })
  mocks.stats.mockResolvedValue([
    { app_id: deploy.app_id, version_name: '2.0.0', install: '10', fail: '2' },
    { app_id: deploy.app_id, version_name: '456', install: 3, fail: 1 },
    { app_id: deploy.app_id, version_name: 'other', install: 500, fail: 1000 },
  ])
})

describe('24h report sending safeguards', () => {
  it('uses authoritative deployment data, the first 24h window and numeric totals', async () => {
    expect((await run()).status).toBe(200)
    expect(mocks.queryJson).toHaveBeenNthCalledWith(1, expect.anything(), DEPLOY_REPORT_SELECT_SQL, claim)
    expect(mocks.stats).toHaveBeenCalledWith(expect.anything(), deploy.app_id, deploy.deployed_at, '2026-11-11T18:15:00.000Z', undefined, { throwOnError: true })
    expect(mocks.queryJson).toHaveBeenNthCalledWith(2, expect.anything(), DEPLOY_REPORT_CONSUME_SQL, [...claim, 456, '2.0.0', deploy.owner_org, deploy.deployed_at])
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), 'bundle:install_stats_24h', 'deploy_stats_24h', deploy.owner_org, undefined, { requireCompleteRecipients: true })
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      report_schema_version: '3', failure_count_24h: '3', install_count_24h: '13', install_count_is_estimate: 'true',
      window_start: deploy.deployed_at, window_end: '2026-11-11T18:15:00.000Z',
      app_name: deploy.app_name, channel_name: deploy.channel_name, version_name: '2.0.0',
    }))
    expect(mocks.send.mock.calls[0][0]).not.toHaveProperty('adoption_percent')
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it.each([undefined, '', 'invalid'])('does not send legacy or malformed claim %s', async (reportClaimedAt) => {
    expect(await (await run({ reportClaimedAt })).json()).toMatchObject({ reason: 'invalid_report_claim' })
    expect(mocks.queryJson).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('does not send legacy unverified jobs during a rolling deployment', async () => {
    expect(await (await run({ type: 'deploy_install_stats' })).json()).toMatchObject({ reason: 'legacy_report_job' })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.stats).not.toHaveBeenCalled()
  })

  it('suppresses ineligible, deleted, paused, expired or superseded deployments', async () => {
    mocks.queryJson.mockResolvedValue([])
    expect(await (await run()).json()).toMatchObject({ reason: 'deployment_no_longer_eligible' })
    expect(mocks.stats).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('suppresses a stale cached read when the final conditional write rejects the state', async () => {
    mocks.queryJson.mockResolvedValueOnce([deploy]).mockResolvedValueOnce([])
    expect(await (await run()).json()).toMatchObject({ reason: 'deployment_changed_or_claim_consumed' })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('defers provider failures instead of presenting missing analytics as zero', async () => {
    mocks.stats.mockRejectedValue(new Error('provider unavailable'))
    expect(await (await run()).json()).toMatchObject({ status: 'deferred' })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenCalledWith(DEPLOY_REPORT_RELEASE_SQL, claim)
  })

  it.each(['NaN', 'Infinity', -1, null, 2.5])('never sends malformed matching counts: %s', async (install) => {
    mocks.stats.mockResolvedValue([{ app_id: deploy.app_id, version_name: '2.0.0', install }])
    expect(await (await run()).json()).toMatchObject({ reason: 'invalid_or_unavailable_analytics' })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'NaN', 'Infinity', -1, null, 2.5, Number.MAX_SAFE_INTEGER + 1])('defers invalid failure counts: %s', async (fail) => {
    mocks.stats.mockResolvedValue([{ app_id: deploy.app_id, version_name: '2.0.0', install: 10, fail }])
    expect(await (await run()).json()).toMatchObject({ reason: 'invalid_or_unavailable_analytics' })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenCalledWith(DEPLOY_REPORT_RELEASE_SQL, claim)
  })

  it.each([0, 1])('reports failures even with only %s install events', async (install) => {
    mocks.stats.mockResolvedValue([{ app_id: deploy.app_id, version_name: '2.0.0', install, fail: 2 }])
    expect((await run()).status).toBe(200)
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ install_count_24h: String(install), failure_count_24h: '2' }))
  })

  it('reports a measured zero without claiming release health', async () => {
    mocks.stats.mockResolvedValue([{ app_id: deploy.app_id, version_name: '2.0.0', install: 10, fail: 0 }])
    expect((await run()).status).toBe(200)
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ failure_count_24h: '0' }))
    expect(mocks.send.mock.calls[0][0]).not.toHaveProperty('success_rate')
  })

  it('rejects mixed-app results', async () => {
    mocks.stats.mockResolvedValue([{ app_id: 'com.example.wrong', version_name: '2.0.0', install: 50 }])
    expect(await (await run()).json()).toMatchObject({ status: 'deferred' })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each([{ rows: [] }, { rows: [{ app_id: deploy.app_id, version_name: '2.0.0', install: 1, fail: 0 }] }])('defers insufficient activity', async ({ rows }) => {
    mocks.stats.mockResolvedValue(rows)
    expect(await (await run()).json()).toMatchObject({ reason: 'not_enough_installs' })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('does not send when state lookup fails', async () => {
    mocks.queryJson.mockRejectedValue(new Error('DB unavailable'))
    expect((await run()).status).toBe(500)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('keeps the original claim retryable when recipient preparation fails', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('Recipient DB unavailable'))
    expect((await run()).status).toBe(500)
    expect(mocks.queryJson).toHaveBeenCalledTimes(1)
    expect(mocks.queryJson).not.toHaveBeenCalledWith(expect.anything(), DEPLOY_REPORT_CONSUME_SQL, expect.anything())
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()

    expect((await run()).status).toBe(200)
    expect(mocks.send).toHaveBeenCalledOnce()
  })

  it('does not consume the claim when no recipient can receive a report', async () => {
    mocks.prepare.mockResolvedValue(null)
    expect(await (await run()).json()).toEqual({ status: 'skipped', reason: 'no_eligible_recipients' })
    expect(mocks.queryJson).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('weekly report delivery', () => {
  it('sends explicit event counts and the same completed-day range used by SQL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-03T12:30:00Z'))
    try {
      mocks.queryJson.mockResolvedValue([{ all_updates: '20', failed_updates: '2', update_checks: '1500000' }])
      mocks.query.mockResolvedValue({ rows: [{ owner_org: deploy.owner_org }] })
      expect((await run({ type: 'weekly_install_stats' })).status).toBe(200)
      expect(mocks.queryJson).toHaveBeenCalledWith(expect.anything(), WEEKLY_REPORT_SQL, [deploy.app_id, '2025-12-27', '2026-01-03'])
      expect(mocks.sendWeekly).toHaveBeenCalledWith(expect.anything(), 'user:weekly_stats', 'weekly_stats', expect.objectContaining({
        window_start: '2025-12-27', window_end: '2026-01-03', weekly_install: '20', weekly_fail: '2', weekly_update_checks: '1500000',
      }), deploy.owner_org)
      expect(mocks.sendWeekly.mock.calls[0][3]).not.toHaveProperty('weekly_open')
      expect(mocks.close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not send malformed analytics as zero activity', async () => {
    mocks.queryJson.mockResolvedValue([{ all_updates: null, failed_updates: 1, update_checks: 100 }])
    expect((await run({ type: 'weekly_install_stats' })).status).toBe(500)
    expect(mocks.sendWeekly).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('does not send a report when only update checks were recorded', async () => {
    mocks.queryJson.mockResolvedValue([{ all_updates: 0, failed_updates: 0, update_checks: 1500000 }])
    expect((await run({ type: 'weekly_install_stats' })).status).toBe(200)
    expect(mocks.sendWeekly).not.toHaveBeenCalled()
  })
})

describe('org-batched weekly/monthly reports', () => {
  const orgA = '00000000-0000-4000-8000-00000000000a'
  const orgB = '00000000-0000-4000-8000-00000000000b'
  const batch = (type: string, appIds: unknown) => run({ type, appIds, orgId: orgA, appId: undefined })

  it('uses the producer window anchor when the message is consumed on a later day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-02T00:05:00Z'))
    try {
      mocks.queryJson.mockResolvedValue([])
      expect((await run({ type: 'weekly_install_stats', appIds: ['app.a1'], orgId: orgA, appId: undefined, windowAnchor: '2026-01-31T23:59:00+00:00' })).status).toBe(200)
      expect(mocks.queryJson).toHaveBeenLastCalledWith(expect.anything(), WEEKLY_REPORT_BATCH_SQL, [['app.a1'], '2026-01-24', '2026-01-31'])
      expect((await run({ type: 'monthly_create_stats', appIds: ['app.a1'], orgId: orgA, appId: undefined, windowAnchor: '2026-01-31T23:59:00+00:00' })).status).toBe(200)
      expect(mocks.queryJson).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), [['app.a1'], '2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects an invalid window anchor', async () => {
    expect((await run({ type: 'weekly_install_stats', appIds: ['app.a1'], orgId: orgA, appId: undefined, windowAnchor: 'not-a-date' })).status).toBe(500)
    expect(mocks.queryJson).not.toHaveBeenCalled()
  })

  it('resolves recipients once per org and emails only apps with installs or failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-03T12:30:00Z'))
    try {
      mocks.queryJson.mockResolvedValue([
        { app_id: 'app.a1', owner_org: orgA, all_updates: '20', failed_updates: '0', update_checks: '5' },
        { app_id: 'app.a2', owner_org: orgA, all_updates: '0', failed_updates: '3', update_checks: '5' },
        { app_id: 'app.a3', owner_org: orgA, all_updates: '0', failed_updates: '0', update_checks: '900' },
        { app_id: 'app.b1', owner_org: orgB, all_updates: '1', failed_updates: '0', update_checks: '1' },
      ])
      expect((await batch('weekly_install_stats', ['app.a1', 'app.a2', 'app.a3', 'app.b1', 'app.deleted'])).status).toBe(200)
      expect(mocks.queryJson).toHaveBeenCalledOnce()
      expect(mocks.queryJson).toHaveBeenCalledWith(expect.anything(), WEEKLY_REPORT_BATCH_SQL, [['app.a1', 'app.a2', 'app.a3', 'app.b1', 'app.deleted'], '2025-12-27', '2026-01-03'])
      expect(mocks.prepare).toHaveBeenCalledTimes(2)
      expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), 'user:weekly_stats', 'weekly_stats', orgA, undefined, { requireCompleteRecipients: true })
      expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), 'user:weekly_stats', 'weekly_stats', orgB, undefined, { requireCompleteRecipients: true })
      expect(mocks.send.mock.calls.map(call => call[0].app_id)).toEqual(['app.a1', 'app.a2', 'app.b1'])
      expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
        app_id: 'app.a1', window_start: '2025-12-27', window_end: '2026-01-03', weekly_install: '20', weekly_fail: '0', weekly_update_checks: '5',
      }))
      expect(mocks.sendWeekly).not.toHaveBeenCalled()
      expect(mocks.close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing when any app has malformed analytics, so a retry cannot duplicate emails', async () => {
    mocks.queryJson.mockResolvedValue([
      { app_id: 'app.a1', owner_org: orgA, all_updates: '20', failed_updates: '0', update_checks: '5' },
      { app_id: 'app.a2', owner_org: orgA, all_updates: null, failed_updates: '1', update_checks: '5' },
    ])
    expect((await batch('weekly_install_stats', ['app.a1', 'app.a2'])).status).toBe(500)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('sends nothing when recipient resolution fails for one org', async () => {
    mocks.queryJson.mockResolvedValue([
      { app_id: 'app.a1', owner_org: orgA, all_updates: '20', failed_updates: '0', update_checks: '5' },
      { app_id: 'app.b1', owner_org: orgB, all_updates: '1', failed_updates: '0', update_checks: '1' },
    ])
    mocks.prepare.mockResolvedValueOnce({ send: mocks.send }).mockRejectedValueOnce(new Error('Recipient DB unavailable'))
    expect((await batch('weekly_install_stats', ['app.a1', 'app.b1'])).status).toBe(500)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('emails monthly stats for apps with bundles or publishes once per org', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))
    try {
      mocks.queryJson.mockResolvedValue([
        { app_id: 'app.a1', owner_org: orgA, bundle_count: 2, publish_count: 0 },
        { app_id: 'app.a2', owner_org: orgA, bundle_count: 0, publish_count: 4 },
        { app_id: 'app.a3', owner_org: orgA, bundle_count: 0, publish_count: 0 },
      ])
      expect((await batch('monthly_create_stats', ['app.a1', 'app.a2', 'app.a3'])).status).toBe(200)
      expect(mocks.queryJson).toHaveBeenCalledWith(expect.anything(), MONTHLY_REPORT_BATCH_SQL, [['app.a1', 'app.a2', 'app.a3'], '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'])
      expect(mocks.prepare).toHaveBeenCalledOnce()
      expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), 'org:monthly_create_stats', 'monthly_stats', orgA, undefined, { requireCompleteRecipients: true })
      expect(mocks.send.mock.calls.map(call => call[0])).toEqual([
        { app_id: 'app.a1', month_name: 'February', monthly_bundles_created: '2', monthly_publishes: '0' },
        { app_id: 'app.a2', month_name: 'February', monthly_bundles_created: '0', monthly_publishes: '4' },
      ])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not resolve recipients when no app has anything to report', async () => {
    mocks.queryJson.mockResolvedValue([{ app_id: 'app.a3', owner_org: orgA, bundle_count: 0, publish_count: 0 }])
    expect((await batch('monthly_create_stats', ['app.a3'])).status).toBe(200)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it.each([[[]], ['app.a1'], [[1]], [['']]])('rejects malformed appIds %j', async (appIds) => {
    expect((await batch('weekly_install_stats', appIds)).status).toBe(500)
    expect(mocks.queryJson).not.toHaveBeenCalled()
  })
})
