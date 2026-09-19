import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __queueConsumerTestUtils__, MAX_QUEUE_READS } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import { buildOnboardingTelemetryQueries, onboardingRefreshBody, readOnboardingTelemetry } from '../supabase/functions/_backend/utils/app_onboarding_refresh.ts'

const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/cloudflare.ts')>(), runQueryToCFA: mocks.run }))
const now = new Date('2026-09-17T12:00:00Z')
const apps = [{ app_id: 'com.example.onboarding', created_at: '2026-01-01T00:00:00Z' }]
const context = { env: { VERSION_USAGE: {}, DEVICE_INFO: {} }, get: () => 'fixture-request' } as unknown as Context

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CF_ANALYTICS_TOKEN', 'test-only')
  vi.stubEnv('CF_ACCOUNT_ANALYTICS_ID', 'test-account')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('backend onboarding refresh telemetry', () => {
  it.concurrent('queries Cloudflare production set-derived installs and device sources, bounded to retention and exact apps', () => {
    const q = buildOnboardingTelemetryQueries(apps, now)
    expect(q.installs).toContain('FROM version_usage')
    expect(q.installs).toContain('blob3 = \'install\'')
    expect(q.installs).toContain('blob2 NOT IN (\'\', \'builtin\', \'unknown\')')
    expect(q.installs).toContain('index1 = \'com.example.onboarding\'')
    expect(q.installs).toContain('timestamp >= toDateTime(\'2026-06-17 12:00:00\')')
    expect(q.installs).toContain('GROUP BY index1 LIMIT 20')
    expect(q.devices).toContain('FROM device_info')
    expect(q.devices).toContain('double2 = 1 AND double3 = 0')
    expect(q.devices).toContain('GROUP BY index1, stage LIMIT 120')
    expect(`${q.installs}${q.devices}`).not.toMatch(/daily_version|public\.devices/)
  })
  it.concurrent('starts at app creation for a new app and safely escapes app identifiers', () => {
    const q = buildOnboardingTelemetryQueries([{ app_id: 'com.example.o\'hare', created_at: '2026-09-16T10:00:00Z' }], now)
    expect(q.installs).toContain('index1 = \'com.example.o\'\'hare\'')
    expect(q.installs).toContain('timestamp >= toDateTime(\'2026-09-16 10:00:00\')')
  })
  it.concurrent('accepts an existing app ID longer than 255 characters in a single-app batch', () => {
    const appId = `000.${'a'.repeat(252)}`
    const q = buildOnboardingTelemetryQueries([{ app_id: appId, created_at: null }], now)
    expect(q.installs).toContain(`index1 = '${appId}'`)
    expect(q.installs.length).toBeLessThan(9000)
    expect(onboardingRefreshBody.safeParse({ appIds: [appId], batchToken: '11111111-1111-4111-8111-111111111111' }).success).toBe(true)
  })
  it.concurrent('keeps twenty escaped short IDs within the Cloudflare query budget', () => {
    const q = buildOnboardingTelemetryQueries(Array.from({ length: 20 }, (_, i) => ({ app_id: `${i.toString().padStart(2, '0')}${'\''.repeat(126)}`, created_at: null })), now)
    expect(Math.max(q.installs.length, q.devices.length)).toBeLessThanOrEqual(9000)
  })
  it.concurrent.each([
    { current: '2026-05-31T12:13:14Z', cutoff: '2026-02-28 12:13:14' },
    { current: '2028-05-31T12:13:14Z', cutoff: '2028-02-29 12:13:14' },
    { current: '2026-12-31T12:13:14Z', cutoff: '2026-09-30 12:13:14' },
    { current: '2026-01-31T12:13:14Z', cutoff: '2025-10-31 12:13:14' },
  ])('clamps three-month windows to the target month at $current', ({ current, cutoff }) => {
    const q = buildOnboardingTelemetryQueries([{ ...apps[0], created_at: '2025-01-01T00:00:00Z' }], new Date(current))
    expect(q.installs).toContain(`timestamp >= toDateTime('${cutoff}')`)
    expect(q.devices).toContain(`timestamp >= toDateTime('${cutoff}')`)
  })
  it.concurrent('rejects oversized batches and SQL rather than silently truncating evidence', () => {
    expect(() => buildOnboardingTelemetryQueries(Array.from({ length: 21 }, () => ({ ...apps[0] })), now)).toThrow('batch size')
    expect(() => buildOnboardingTelemetryQueries(Array.from({ length: 20 }, () => ({ ...apps[0], app_id: '\''.repeat(255) })), now)).toThrow('size budget')
    expect(onboardingRefreshBody.safeParse({ appIds: Array.from({ length: 21 }).fill(apps[0].app_id), batchToken: '11111111-1111-4111-8111-111111111111' }).success).toBe(false)
  })
  it('combines exact timestamps, last use and the highest observed store stage', async () => {
    const base = { app_id: apps[0].app_id, first_at: '2026-09-01T13:14:15Z', last_at: '2026-09-16T20:00:00Z' }
    mocks.run.mockResolvedValueOnce([base]).mockResolvedValueOnce([{ ...base, stage: 'native_unknown' }, { ...base, stage: 'store_live', first_at: '2026-09-10T00:00:00Z' }])
    expect(await readOnboardingTelemetry(context, apps, now)).toEqual([{
      app_id: apps[0].app_id,
      first_install_at: '2026-09-01T13:14:15.000Z',
      last_install_at: '2026-09-16T20:00:00.000Z',
      last_device_at: '2026-09-16T20:00:00.000Z',
      stage: 'store_live',
    }])
    expect(mocks.run).toHaveBeenCalledTimes(2)
  })
  it('accepts a successful empty result without inventing success', async () => {
    mocks.run.mockResolvedValue([])
    expect(await readOnboardingTelemetry(context, apps, now)).toEqual([{ app_id: apps[0].app_id, first_install_at: null, last_install_at: null, last_device_at: null, stage: 'no_device' }])
  })
  it('propagates a provider failure instead of advancing progress as if no events existed', async () => {
    mocks.run.mockRejectedValue(new Error('Provider unavailable'))
    await expect(readOnboardingTelemetry(context, apps, now)).rejects.toThrow('Provider unavailable')
  })
  it.each([
    [{ app_id: 'another-app', first_at: now, last_at: now }],
    [{ app_id: apps[0].app_id, first_at: 'invalid', last_at: now }],
    [{ app_id: apps[0].app_id, first_at: null, last_at: now }],
    [{ app_id: apps[0].app_id, first_at: '', last_at: now }],
    [{ app_id: apps[0].app_id, first_at: now, last_at: null }],
    [{ app_id: apps[0].app_id, first_at: now, last_at: '' }],
    [{ app_id: apps[0].app_id, first_at: now, last_at: '2026-01-01' }],
    [{ app_id: apps[0].app_id, first_at: now, last_at: '2026-10-01' }],
    [{ app_id: apps[0].app_id, first_at: now, last_at: now }, { app_id: apps[0].app_id, first_at: now, last_at: now }],
  ].map(rows => ({ rows })))('rejects malformed or mismatched provider rows (%j)', async ({ rows }) => {
    mocks.run.mockResolvedValueOnce(rows).mockResolvedValueOnce([])
    await expect(readOnboardingTelemetry(context, apps, now)).rejects.toThrow()
  })
  it('uses the same second precision as Cloudflare when validating app creation', async () => {
    mocks.run.mockResolvedValueOnce([{ app_id: apps[0].app_id, first_at: '2026-09-16T00:00:00Z', last_at: '2026-09-16T00:00:01Z' }]).mockResolvedValueOnce([])
    expect(await readOnboardingTelemetry(context, [{ ...apps[0], created_at: '2026-09-16T00:00:00.500Z' }], now)).toHaveLength(1)
  })
  it('uses the retention window as the lower bound when app creation is missing', async () => {
    mocks.run.mockResolvedValueOnce([{ app_id: apps[0].app_id, first_at: '1970-01-01T00:00:00Z', last_at: now }]).mockResolvedValueOnce([])
    await expect(readOnboardingTelemetry(context, [{ ...apps[0], created_at: null }], now)).rejects.toThrow('invalid onboarding telemetry')
  })
  it('requires Cloudflare configuration and never falls back to Supabase statistics', async () => {
    await expect(readOnboardingTelemetry({ ...context, env: {} } as Context, apps, now)).rejects.toThrow('not configured')
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('aborts hung provider reads within the consumer HTTP budget', async () => {
    vi.useFakeTimers()
    mocks.run.mockImplementation((_c, _query, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const pending = expect(readOnboardingTelemetry(context, apps, now)).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
  })
})

describe('onboarding queue execution budgets', () => {
  it.concurrent('caps one dispatch to 300 apps and awaits acknowledgment within visibility and pg_net deadlines', () => {
    const u = __queueConsumerTestUtils__
    expect(u.getQueueBatchSize('cron_onboarding_refresh', 950)).toBe(1)
    expect(u.getQueueBatchSize('cron_onboarding_refresh_apps', 950)).toBe(15)
    expect(u.getQueueHttpConcurrency('cron_onboarding_refresh_apps')).toBe(15)
    expect(u.getQueueHttpTimeoutMs('cron_onboarding_refresh_apps')).toBe(45_000)
    expect(u.getQueueVisibilityTimeout('cron_onboarding_refresh_apps')).toBe(120)
    expect(u.shouldRunQueueSyncInBackground('cron_onboarding_refresh_apps')).toBe(false)
    expect(u.getQueueMaxReads('cron_onboarding_refresh_apps')).toBe(MAX_QUEUE_READS)
    expect(MAX_QUEUE_READS).toBe(5)
  })
})
