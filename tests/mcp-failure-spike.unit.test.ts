import { describe, expect, it } from 'vitest'
import {
  evaluateFailureSpike,
  formatFailureSpikeValidationError,
  MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS,
  mcpFailureSpikeArgumentsSchema,
  resolveFailureSpikeThresholds,
} from '../supabase/functions/_backend/utils/mcp_failure_spike_policy.ts'
import { MCP_EVENT_CATALOG } from '../supabase/functions/_backend/utils/mcp_events.ts'

const baseArgs = {
  org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  app_id: 'com.demo.app',
}

describe('mcp failure spike policy', () => {
  const thresholds = { ...MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS }

  it('applies recommended defaults when thresholds are omitted', () => {
    expect(resolveFailureSpikeThresholds(baseArgs)).toEqual(MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS)
  })

  it('respects custom thresholds', () => {
    const custom = {
      ...baseArgs,
      min_failures: 3,
      failure_rate_percent: 25,
      min_checks: 10,
      window_minutes: 30,
      cooldown_minutes: 120,
    }
    expect(resolveFailureSpikeThresholds(custom)).toEqual({
      min_failures: 3,
      failure_rate_percent: 25,
      min_checks: 10,
      window_minutes: 30,
      cooldown_minutes: 120,
    })
  })

  it('never fires below min_checks', () => {
    const result = evaluateFailureSpike({
      failures: 100,
      checks: thresholds.min_checks - 1,
      thresholds,
    })
    expect(result.shouldFire).toBe(false)
    expect(result.reason).toBe('below_min_checks')
  })

  it('gates on min_failures', () => {
    const result = evaluateFailureSpike({
      failures: thresholds.min_failures - 1,
      checks: thresholds.min_checks,
      thresholds,
    })
    expect(result.shouldFire).toBe(false)
    expect(result.reason).toBe('below_min_failures')
  })

  it('gates on failure rate percent', () => {
    const result = evaluateFailureSpike({
      failures: 10,
      checks: 200,
      thresholds,
    })
    expect(result.shouldFire).toBe(false)
    expect(result.reason).toBe('below_rate')
  })

  it('fires when all gates pass', () => {
    const result = evaluateFailureSpike({
      failures: 15,
      checks: 100,
      thresholds,
    })
    expect(result.shouldFire).toBe(true)
    expect(result.reason).toBe('triggered')
    expect(result.observedRatePercent).toBe(15)
  })

  it('suppresses during cooldown', () => {
    const now = new Date('2026-11-10T12:00:00.000Z')
    const lastFired = new Date('2026-11-10T11:30:00.000Z')
    const result = evaluateFailureSpike({
      failures: 15,
      checks: 100,
      thresholds,
      lastFiredAt: lastFired,
      now,
    })
    expect(result.shouldFire).toBe(false)
    expect(result.reason).toBe('cooldown')
  })

  it('rejects failure_rate_percent below the catalog minimum', () => {
    const parsed = mcpFailureSpikeArgumentsSchema.safeParse({ ...baseArgs, failure_rate_percent: 0 })
    expect(parsed.success).toBe(false)
    if (!parsed.success)
      expect(formatFailureSpikeValidationError(parsed.error)).toContain('failure_rate_percent')
  })

  it('rejects cooldown shorter than window', () => {
    const parsed = mcpFailureSpikeArgumentsSchema.safeParse({
      ...baseArgs,
      cooldown_minutes: 5,
      window_minutes: 15,
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success)
      expect(formatFailureSpikeValidationError(parsed.error)).toContain('cooldown_minutes')
  })

  it('accepts cooldown equal to window', () => {
    const parsed = mcpFailureSpikeArgumentsSchema.safeParse({
      ...baseArgs,
      cooldown_minutes: 15,
      window_minutes: 15,
    })
    expect(parsed.success).toBe(true)
  })

  it('exposes recommended defaults in the event catalog', () => {
    const entry = MCP_EVENT_CATALOG.find(event => event.name === 'update.failure_spike')
    expect(entry?.recommendedDefaults).toMatchObject(MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS)
    expect(entry?.recommendedDefaultsNote).toContain('device count')
  })
})
