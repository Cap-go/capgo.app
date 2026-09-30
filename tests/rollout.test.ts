import { describe, expect, it } from 'vitest'
import { __rolloutAutoPauseTestUtils__ } from '../supabase/functions/_backend/triggers/cron_rollout_auto_pause.ts'
import { evaluateAutoPausePolicy } from '../supabase/functions/_backend/utils/rollout.ts'

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
