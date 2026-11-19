import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readRolloutVersionTotalsCF: vi.fn(),
  readStatsVersion: vi.fn(),
  sendEventToTracking: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  readStatsVersion: mocks.readStatsVersion,
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare_rollout_stats.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/cloudflare_rollout_stats.ts')>(),
  readRolloutVersionTotalsCF: mocks.readRolloutVersionTotalsCF,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: mocks.sendEventToTracking,
}))

const { __rolloutAutoPauseTestUtils__ } = await import('../supabase/functions/_backend/triggers/cron_rollout_auto_pause.ts')

const NOW = new Date('2026-11-17T12:00:00.000Z')

function context() {
  return {
    env: { VERSION_USAGE: {}, APP_LOG: {} },
    get: vi.fn((key: string) => key === 'requestId' ? 'test-request' : undefined),
  } as unknown as Context
}

function channel(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `channel-${id}`,
    app_id: `app.${id % 3}`,
    owner_org: 'org-1',
    rollout_version: 1000 + id,
    rollout_version_info: { name: `1.0.${id}` },
    auto_pause_enabled: true,
    auto_pause_action: 'pause',
    auto_pause_confidence: 0.95,
    auto_pause_cooldown_minutes: 60,
    auto_pause_failure_rate_bps: 500,
    auto_pause_last_triggered_at: null,
    auto_pause_min_attempts: 10,
    auto_pause_min_failures: 5,
    auto_pause_window_minutes: 60,
    rollout_paused_at: null,
    ...overrides,
  }
}

function fakePg() {
  const queries: Array<{ text: string, values: unknown[] }> = []
  return {
    queries,
    pg: {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        queries.push({ text, values })
        if (text.includes('pg_catalog.unnest($2::bigint[])'))
          return { rows: (values[1] as number[]).map(id => ({ id })), rowCount: (values[1] as number[]).length }
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }),
    },
  }
}

const healthy = { installs: 1000, failures: 1 }
const failing = { installs: 100, failures: 90 }

beforeEach(() => {
  mocks.readRolloutVersionTotalsCF.mockReset()
  mocks.readStatsVersion.mockReset()
  mocks.sendEventToTracking.mockReset()
})

describe('rollout auto-pause batched evaluation', () => {
  it('reads one query pair per app (20 channels at most) and stamps untriggered ones in one update', async () => {
    // 45 channels: app.0 has 25 (split 20 + 5), app.1 and app.2 have 10 each.
    const channels = Array.from({ length: 45 }, (_, index) => channel(index + 1, { app_id: index < 25 ? 'app.0' : index < 35 ? 'app.1' : 'app.2' }))
    mocks.readRolloutVersionTotalsCF.mockImplementation(async (_c: Context, windows: Array<{ channel: { id: number } }>) =>
      windows.map(window => window.channel.id === 7 ? failing : healthy))
    const { pg, queries } = fakePg()

    const result = await __rolloutAutoPauseTestUtils__.evaluateChannels(context(), pg as any, channels as any, NOW)

    expect(result).toEqual({ checked: 45, triggered: 1, deferred: 0 })
    const calls = mocks.readRolloutVersionTotalsCF.mock.calls.map(call => call[1] as Array<{ appId: string }>)
    expect(calls.map(windows => windows.length).sort((a, b) => a - b)).toEqual([5, 10, 10, 20])
    for (const windows of calls)
      expect(new Set(windows.map(window => window.appId)).size).toBe(1)
    const firstWindow = calls.find(windows => windows.length === 20)![0]
    expect(firstWindow).toEqual({ appId: 'app.0', channel: { id: 1, name: 'channel-1' }, versionName: '1.0.1', start: '2026-11-17T11:00:00.000Z' })

    const stamps = queries.filter(query => query.text.includes('pg_catalog.unnest($2::bigint[])'))
    expect(stamps).toHaveLength(4)
    const stampedIds = stamps.flatMap(query => query.values[1] as number[])
    expect(stampedIds).toHaveLength(44)
    expect(stampedIds).not.toContain(7)
    const firstStamp = stamps.find(query => (query.values[1] as number[]).includes(1))!
    expect(firstStamp.values[2]).toEqual(channels.slice(0, 20).filter(ch => ch.id !== 7).map(ch => ch.rollout_version))

    // The triggered channel is paused through the guarded single-channel update.
    const pause = queries.find(query => query.text.includes('"rollout_paused_at" = $'))
    expect(pause?.values.slice(0, 2)).toEqual([7, 1007])
    expect(pause?.text).toContain('AND rollout_version = $2')
  })

  it('stops starting chunks once the time budget is spent and leaves the rest unstamped', async () => {
    const channels = Array.from({ length: 50 }, (_, index) => channel(index + 1, { app_id: 'app.0' }))
    const { pg, queries } = fakePg()
    let now = 0
    const clock = () => now
    mocks.readRolloutVersionTotalsCF.mockImplementation(async (_c: Context, windows: unknown[]) => {
      now += 6_000
      return windows.map(() => healthy)
    })

    const result = await __rolloutAutoPauseTestUtils__.evaluateChannels(context(), pg as any, channels as any, NOW, { chunkSize: 10, concurrency: 1, timeBudgetMs: 9_000, clock })

    expect(mocks.readRolloutVersionTotalsCF).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ checked: 20, triggered: 0, deferred: 30 })
    const stampedIds = queries.flatMap(query => query.values[1] as number[])
    expect(stampedIds).toEqual(channels.slice(0, 20).map(ch => ch.id))
  })

  it('does not stamp channels whose stats could not be read, and records the attempt', async () => {
    mocks.readRolloutVersionTotalsCF.mockResolvedValue(null)
    const { pg, queries } = fakePg()

    const result = await __rolloutAutoPauseTestUtils__.evaluateChannels(context(), pg as any, [channel(1, { app_id: 'app.x' }), channel(2, { app_id: 'app.x' })] as any, NOW)

    expect(result).toEqual({ checked: 0, triggered: 0, deferred: 0 })
    expect(queries).toHaveLength(1)
    expect(queries[0]!.text).toContain('INSERT INTO public.channel_auto_pause_attempts')
    expect(queries[0]!.text).not.toContain('UPDATE public.channels')
    expect(queries[0]!.values).toEqual([NOW.toISOString(), [1, 2]])
  })

  it('treats a failed Postgres fallback read as a failure, not as zero data', async () => {
    const pgContext = { ...context(), env: {} } as unknown as Context
    mocks.readStatsVersion.mockRejectedValueOnce(new Error('database unavailable'))
    const { pg, queries } = fakePg()

    const result = await __rolloutAutoPauseTestUtils__.evaluateChannels(pgContext, pg as any, [channel(1, { app_id: 'app.x' }), channel(2, { app_id: 'app.x' })] as any, NOW)

    expect(mocks.readStatsVersion).toHaveBeenCalledTimes(1)
    expect(mocks.readStatsVersion.mock.calls[0]![5]).toEqual({ throwOnError: true })
    expect(result).toEqual({ checked: 0, triggered: 0, deferred: 0 })
    expect(queries.map(query => query.text).join('\n')).not.toContain('UPDATE public.channels')
    expect(queries[0]!.text).toContain('INSERT INTO public.channel_auto_pause_attempts')
  })

  it('evaluates through the Postgres fallback when Analytics Engine is not configured', async () => {
    const pgContext = { ...context(), env: {} } as unknown as Context
    mocks.readStatsVersion.mockResolvedValue([
      { app_id: 'app.1', version_name: '1.0.1', date: '2026-11-17', get: 0, fail: 1, install: 1000, uninstall: 0 },
      { app_id: 'app.1', version_name: '0.9.0', date: '2026-11-17', get: 0, fail: 900, install: 1000, uninstall: 0 },
    ])
    const { pg, queries } = fakePg()

    const result = await __rolloutAutoPauseTestUtils__.evaluateChannels(pgContext, pg as any, [channel(1)] as any, NOW)

    expect(result).toEqual({ checked: 1, triggered: 0, deferred: 0 })
    expect(queries[0]!.text).toContain('UPDATE public.channels ch')
  })

  it('keeps notify and rollback actions', async () => {
    mocks.readRolloutVersionTotalsCF.mockImplementation(async (_c: Context, windows: unknown[]) => windows.map(() => failing))
    const { pg, queries } = fakePg()

    const result = await __rolloutAutoPauseTestUtils__.evaluateChannels(context(), pg as any, [
      channel(1, { auto_pause_action: 'notify' }),
      channel(2, { auto_pause_action: 'rollback' }),
    ] as any, NOW)

    expect(result).toEqual({ checked: 2, triggered: 2, deferred: 0 })
    expect(mocks.sendEventToTracking).toHaveBeenCalledTimes(1)
    expect(mocks.sendEventToTracking.mock.calls[0]![1]).toMatchObject({ event: 'Rollout Auto-Pause Notification', tags: { channel_id: 1 } })
    const rollback = queries.find(query => query.values[0] === 2)
    expect(rollback?.text).toContain('"rollout_enabled" =')
    expect(rollback?.text).toContain('"rollout_version" =')
    expect(queries.some(query => query.text.includes('pg_catalog.unnest($2::bigint[])'))).toBe(false)
  })
})
