import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/triggers/cron_email.ts'
import { DEPLOY_REPORT_CONSUME_SQL, DEPLOY_REPORT_RELEASE_SQL, DEPLOY_REPORT_SELECT_SQL } from '../supabase/functions/_backend/utils/deploy_report.ts'

const mocks = vi.hoisted(() => ({
  queryJson: vi.fn(),
  query: vi.fn(),
  stats: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
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
vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({ sendEmailToOrgMembers: mocks.send }))
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
  mocks.queryJson.mockResolvedValue([deploy])
  mocks.query.mockResolvedValue({ rows: [] })
  mocks.stats.mockResolvedValue([
    { app_id: deploy.app_id, version_name: '2.0.0', install: '10' },
    { app_id: deploy.app_id, version_name: '456', install: 3 },
    { app_id: deploy.app_id, version_name: 'other', install: 500 },
  ])
})

describe('24h report sending safeguards', () => {
  it('uses authoritative deployment data, the first 24h window and numeric totals', async () => {
    expect((await run()).status).toBe(200)
    expect(mocks.queryJson).toHaveBeenNthCalledWith(1, expect.anything(), DEPLOY_REPORT_SELECT_SQL, claim)
    expect(mocks.stats).toHaveBeenCalledWith(expect.anything(), deploy.app_id, deploy.deployed_at, '2026-11-11T18:15:00.000Z', undefined, { throwOnError: true })
    expect(mocks.queryJson).toHaveBeenNthCalledWith(2, expect.anything(), DEPLOY_REPORT_CONSUME_SQL, [...claim, 456, '2.0.0', deploy.owner_org, deploy.deployed_at])
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), 'bundle:install_stats_24h', 'deploy_stats_24h', expect.objectContaining({
      report_schema_version: '2', install_count_24h: '13', install_count_is_estimate: 'true',
      window_start: deploy.deployed_at, window_end: '2026-11-11T18:15:00.000Z',
      app_name: deploy.app_name, channel_name: deploy.channel_name, version_name: '2.0.0',
    }), deploy.owner_org)
    expect(mocks.send.mock.calls[0][3]).not.toHaveProperty('adoption_percent')
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

  it('rejects mixed-app results', async () => {
    mocks.stats.mockResolvedValue([{ app_id: 'com.example.wrong', version_name: '2.0.0', install: 50 }])
    expect(await (await run()).json()).toMatchObject({ status: 'deferred' })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each([{ rows: [] }, { rows: [{ app_id: deploy.app_id, version_name: '2.0.0', install: 1 }] }])('defers insufficient activity', async ({ rows }) => {
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
})
