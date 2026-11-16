import { describe, expect, it } from 'vitest'
import { observeEventsForPlan } from '../src/services/observePlanAllowance.ts'

describe('observe plan allowance', () => {
  it('uses the plan row when the column is present', () => {
    expect(observeEventsForPlan({ name: 'Solo', observe_events: 500_000 })).toBe(500_000)
    expect(observeEventsForPlan({ name: 'Maker', observe_events: 3_000_000 })).toBe(3_000_000)
    expect(observeEventsForPlan({ name: 'Team', observe_events: 20_000_000 })).toBe(20_000_000)
    expect(observeEventsForPlan({ name: 'Enterprise', observe_events: 600_000_000 })).toBe(600_000_000)
  })

  it('falls back to the published allowance when the column is missing', () => {
    expect(observeEventsForPlan({ name: 'Solo' })).toBe(500_000)
    expect(observeEventsForPlan({ name: 'Maker', observe_events: 0 })).toBe(3_000_000)
    expect(observeEventsForPlan({ name: 'Unknown' })).toBe(0)
  })
})
