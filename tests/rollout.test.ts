import { describe, expect, it } from 'vitest'
import { __rolloutAutoPauseTestUtils__ } from '../supabase/functions/_backend/triggers/cron_rollout_auto_pause.ts'
import { evaluateAutoPausePolicy, getDeltaProbabilityBps, resolveRolloutDecision } from '../supabase/functions/_backend/utils/rollout.ts'

const baseDecision = {
  appId: 'com.test.rollout',
  channelId: 1,
  currentVersionName: '1.0.0',
  deviceId: 'device-a',
  rolloutCacheTtlSeconds: 3600,
  rolloutEnabled: true,
  rolloutId: '11111111-1111-4111-8111-111111111111',
  rolloutPausedAt: null,
  rolloutPercentageBps: 0,
  rolloutVersionId: 10,
  rolloutVersionName: '1.1.0',
  now: new Date('2026-05-06T12:00:00.000Z'),
}

describe('rollout decisions', () => {
  it.concurrent('returns stable at 0 percent', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 0,
      randomBps: () => 0,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('percentage_zero')
    expect(decision.shouldWriteCache).toBe(false)
  })

  it.concurrent('selects rollout at 100 percent', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 10000,
      randomBps: () => 9999,
    })

    expect(decision.selected).toBe(true)
    expect(decision.reason).toBe('cache_miss')
    expect(decision.payload?.selected).toBe(true)
  })

  it.concurrent('does not honor cached selected devices when percentage is 0', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 0,
      cachePayload: {
        selected: true,
        percentage_bps: 5000,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      randomBps: () => 0,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('percentage_zero')
    expect(decision.shouldWriteCache).toBe(false)
  })

  it.concurrent('keeps cached unselected devices stable when percentage is unchanged', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 2500,
      cachePayload: {
        selected: false,
        percentage_bps: 2500,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      randomBps: () => 0,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('cached_unselected')
    expect(decision.shouldWriteCache).toBe(false)
  })

  it.concurrent('re-samples cached selected devices when percentage decreases', () => {
    const selected = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 2500,
      cachePayload: {
        selected: true,
        percentage_bps: 5000,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      randomBps: () => 4999,
    })

    const notSelected = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 2500,
      cachePayload: {
        selected: true,
        percentage_bps: 5000,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      randomBps: () => 5000,
    })

    expect(selected.selected).toBe(true)
    expect(selected.reason).toBe('percentage_decrease_reroll')
    expect(selected.shouldWriteCache).toBe(true)
    expect(notSelected.selected).toBe(false)
    expect(notSelected.payload?.selected).toBe(false)
  })

  it.concurrent('re-rolls only the delta probability after percentage increases', () => {
    expect(getDeltaProbabilityBps(2000, 5000)).toBe(3750)

    const selected = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 5000,
      cachePayload: {
        selected: false,
        percentage_bps: 2000,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      randomBps: () => 3749,
    })

    const notSelected = resolveRolloutDecision({
      ...baseDecision,
      rolloutPercentageBps: 5000,
      cachePayload: {
        selected: false,
        percentage_bps: 2000,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      randomBps: () => 3750,
    })

    expect(selected.selected).toBe(true)
    expect(notSelected.selected).toBe(false)
  })

  it.concurrent('keeps devices already on rollout on rollout when paused and cache is missing', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      currentVersionName: '1.1.0',
      rolloutEnabled: true,
      rolloutPausedAt: '2026-05-06T11:30:00.000Z',
      rolloutPercentageBps: 0,
    })

    expect(decision.selected).toBe(true)
    expect(decision.reason).toBe('already_on_rollout')
    expect(decision.payload?.selected).toBe(true)
  })

  it.concurrent('does not honor paused rollout version reports when cache says unselected', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      currentVersionName: '1.1.0',
      cachePayload: {
        selected: false,
        percentage_bps: 0,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      rolloutPausedAt: '2026-05-06T11:30:00.000Z',
      rolloutPercentageBps: 10000,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('paused')
  })

  it.concurrent('moves devices already on rollout back to stable when disabled', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      currentVersionName: '1.1.0',
      rolloutEnabled: false,
      rolloutPercentageBps: 10000,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('disabled')
  })

  it.concurrent('does not expose new devices while paused', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      rolloutPausedAt: '2026-05-06T11:30:00.000Z',
      rolloutPercentageBps: 10000,
      randomBps: () => 0,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('paused')
  })

  it.concurrent('does not expose cached selected devices while paused unless already installed', () => {
    const decision = resolveRolloutDecision({
      ...baseDecision,
      cachePayload: {
        selected: true,
        percentage_bps: 10000,
        rollout_id: baseDecision.rolloutId,
        rollout_version: baseDecision.rolloutVersionId,
        created_at: '2026-05-06T11:00:00.000Z',
        updated_at: '2026-05-06T11:00:00.000Z',
      },
      rolloutPausedAt: '2026-05-06T11:30:00.000Z',
      rolloutPercentageBps: 10000,
      randomBps: () => 0,
    })

    expect(decision.selected).toBe(false)
    expect(decision.reason).toBe('paused')
  })
})

describe('rollout auto-pause policy', () => {
  it.concurrent('respects disabled state', () => {
    const result = evaluateAutoPausePolicy({
      action: 'pause',
      confidence: 0.95,
      cooldownMinutes: 60,
      enabled: false,
      failureRateBps: 100,
      failures: 100,
      installs: 0,
    })

    expect(result.shouldTrigger).toBe(false)
    expect(result.reason).toBe('disabled')
  })

  it.concurrent('respects configurable minimums and cooldown', () => {
    const lowAttempts = evaluateAutoPausePolicy({
      action: 'pause',
      confidence: 0.95,
      cooldownMinutes: 60,
      enabled: true,
      failureRateBps: 100,
      failures: 2,
      installs: 3,
      minAttempts: 10,
    })

    const coolingDown = evaluateAutoPausePolicy({
      action: 'rollback',
      confidence: 0.95,
      cooldownMinutes: 60,
      enabled: true,
      failureRateBps: 100,
      failures: 100,
      installs: 0,
      lastTriggeredAt: '2026-05-06T11:30:00.000Z',
      now: new Date('2026-05-06T12:00:00.000Z'),
    })

    expect(lowAttempts.reason).toBe('insufficient_attempts')
    expect(coolingDown.reason).toBe('cooldown')
  })

  it.concurrent('does not trigger a zero bps threshold when there are no failures', () => {
    const result = evaluateAutoPausePolicy({
      action: 'pause',
      confidence: 0.95,
      cooldownMinutes: 0,
      enabled: true,
      failureRateBps: 0,
      failures: 0,
      installs: 100,
    })

    expect(result.shouldTrigger).toBe(false)
    expect(result.reason).toBe('below_threshold')
  })

  it.concurrent('uses confidence lower bound before triggering configured action', () => {
    const result = evaluateAutoPausePolicy({
      action: 'rollback',
      confidence: 0.8,
      cooldownMinutes: 0,
      enabled: true,
      failureRateBps: 5000,
      failures: 95,
      installs: 5,
      minAttempts: 10,
      minFailures: 10,
    })

    expect(result.shouldTrigger).toBe(true)
    expect(result.action).toBe('rollback')
    expect(result.reason).toBe('triggered')
  })
})

describe('rollout auto-pause channel loading', () => {
  it.concurrent('pages through all matching channels', async () => {
    const pageOne = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }))
    const pageTwo = [{ id: 1001 }, { id: 1002 }]
    const rangeCalls: Array<[number, number]> = []
    const pages = [pageOne, pageTwo]

    const gtCalls: Array<[string, number]> = []
    const supabase = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          gt: (column: string, value: number) => {
            gtCalls.push([column, value])
            return query
          },
          not: () => query,
          is: () => query,
          order: () => query,
          range: (from: number, to: number) => {
            rangeCalls.push([from, to])
            return Promise.resolve({ data: pages.shift() ?? [], error: null })
          },
        }
        return query
      },
    }

    const result = await __rolloutAutoPauseTestUtils__.loadAutoPauseChannels(supabase as any)

    expect(result.error).toBeNull()
    expect(result.data).toHaveLength(1002)
    expect(gtCalls).toEqual([
      ['rollout_percentage_bps', 0],
      ['rollout_percentage_bps', 0],
    ])
    expect(rangeCalls).toEqual([[0, 999], [1000, 1999]])
  })
})
