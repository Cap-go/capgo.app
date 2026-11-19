import { describe, expect, it } from 'vitest'
import { buildQueuePriorityTestUtils } from '../cli/src/build/queue-priority.ts'
import { nativeBuildQueuePriorityTestUtils } from '../supabase/functions/_backend/utils/native_build_queue_priority.ts'

const {
  computeNativeBuildQueueAgingBonus,
  computeNativeBuildEffectiveQueuePriority,
  nativeBuildQueueTierFromPriority,
} = nativeBuildQueuePriorityTestUtils

const { buildQueuePriorityUserLines, isTopNativeBuildQueueTier } = buildQueuePriorityTestUtils

describe('native build queue priority mapping', () => {
  it.concurrent('maps numeric priority to tiers', () => {
    expect(nativeBuildQueueTierFromPriority(10)).toBe('standard')
    expect(nativeBuildQueueTierFromPriority(20)).toBe('elevated')
    expect(nativeBuildQueueTierFromPriority(40)).toBe('high')
    expect(nativeBuildQueueTierFromPriority(100)).toBe('highest')
  })

  it.concurrent('ages waiting jobs without unbounded growth', () => {
    expect(computeNativeBuildQueueAgingBonus(0)).toBe(0)
    expect(computeNativeBuildQueueAgingBonus(299)).toBe(0)
    expect(computeNativeBuildQueueAgingBonus(300)).toBe(1)
    expect(computeNativeBuildQueueAgingBonus(60 * 60)).toBe(12)
    expect(computeNativeBuildQueueAgingBonus(24 * 60 * 60)).toBe(90)
  })

  it.concurrent('computes effective priority from enqueue time', () => {
    const enqueuedAt = Date.parse('2026-01-01T00:00:00.000Z')
    const now = enqueuedAt + (15 * 60 * 1000)
    expect(computeNativeBuildEffectiveQueuePriority(10, enqueuedAt, now)).toBe(13)
  })
})

describe('CLI build queue priority messaging', () => {
  it.concurrent('nags lower tiers with upgrade link', () => {
    const lines = buildQueuePriorityUserLines({
      queue_priority: 10,
      queue_priority_tier: 'standard',
      upgrade_url: 'https://console.capgo.app/settings/organization/plans',
    })
    expect(lines[0]).toContain('Standard')
    expect(lines[1]).toContain('Upgrade your plan')
    expect(lines[1]).toContain('https://console.capgo.app/settings/organization/plans')
  })

  it.concurrent('does not nag top tier plans', () => {
    expect(isTopNativeBuildQueueTier('highest')).toBe(true)
    const lines = buildQueuePriorityUserLines({
      queue_priority: 100,
      queue_priority_tier: 'highest',
      upgrade_url: 'https://console.capgo.app/settings/organization/plans',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Highest')
  })
})
