import type { Context } from 'hono'
import type { PgClient } from '../supabase/functions/_backend/utils/pg.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  evaluateFailureSpike,
  formatFailureSpikeValidationError,
  MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS,
  mcpFailureSpikeArgumentsSchema,
  resolveFailureSpikeThresholds,
} from '../supabase/functions/_backend/utils/mcp_failure_spike_policy.ts'
import { dispatchMcpEventToWebhook, MCP_EVENT_CATALOG } from '../supabase/functions/_backend/utils/mcp_events.ts'
import {
  evaluateMcpFailureSpikeSubscriptionFromMetrics,
  type McpFailureSpikeWebhookRow,
} from '../supabase/functions/_backend/utils/mcp_failure_spike_runner.ts'

vi.mock('../supabase/functions/_backend/utils/mcp_events.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/mcp_events.ts')>()
  return {
    ...actual,
    dispatchMcpEventToWebhook: vi.fn(),
  }
})

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

describe('failure spike cooldown claim and delivery restore', () => {
  const now = new Date('2026-11-10T12:00:00.000Z')
  const thresholds = { ...MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS }
  const metrics = {
    failures: 20,
    checks: 100,
    version: '1.0.0',
    topFailureActionCodes: [] as { action: string, count: number }[],
    windowStart: '2026-11-10T11:45:00.000Z',
    windowEnd: now.toISOString(),
  }
  const c = { get: () => undefined } as unknown as Context

  const baseWebhook = {
    id: 1,
    org_id: baseArgs.org_id,
    name: 'MCP failure spike',
    secret: 'whsec_test_spike_claim_restore',
    url: 'https://hooks.example.com/capgo/mcp/spike',
    enabled: true,
    events: ['update.failure_spike'],
    delivery_version: 'standard',
    created_at: now.toISOString(),
    created_by: '6aa76066-55ef-4238-ade6-0b32334a4097',
    updated_at: now.toISOString(),
    source: 'mcp',
    mcp_event: 'update.failure_spike',
    mcp_arguments: baseArgs,
    mcp_verified_at: now.toISOString(),
    expires_at: null,
    mcp_spike_last_fired_at: null,
  } as McpFailureSpikeWebhookRow

  function mockPg(claim: boolean) {
    const restores: unknown[][] = []
    const pg = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('RETURNING id'))
          return { rows: claim ? [{ id: 1 }] : [] }
        if (sql.includes('mcp_spike_last_fired_at = $2::timestamptz WHERE id = $1 AND mcp_spike_last_fired_at = $3')) {
          restores.push(params ?? [])
          return { rows: [] }
        }
        return { rows: [] }
      }),
    }
    return { pg: pg as unknown as PgClient, restores }
  }

  it('treats a failed cooldown claim as still in cooldown', async () => {
    vi.mocked(dispatchMcpEventToWebhook).mockReset()
    const { pg } = mockPg(false)
    const result = await evaluateMcpFailureSpikeSubscriptionFromMetrics(
      c,
      pg,
      baseWebhook,
      baseArgs,
      thresholds,
      metrics,
      now,
    )
    expect(result).toEqual({ fired: false, reason: 'cooldown' })
    expect(dispatchMcpEventToWebhook).not.toHaveBeenCalled()
  })

  it('restores mcp_spike_last_fired_at when webhook dispatch fails', async () => {
    vi.mocked(dispatchMcpEventToWebhook).mockReset()
    vi.mocked(dispatchMcpEventToWebhook).mockResolvedValueOnce(false)
    const previousFiredAt = '2026-11-09T12:00:00.000Z'
    const { pg, restores } = mockPg(true)
    const webhook = { ...baseWebhook, mcp_spike_last_fired_at: previousFiredAt }
    const result = await evaluateMcpFailureSpikeSubscriptionFromMetrics(
      c,
      pg,
      webhook,
      baseArgs,
      thresholds,
      metrics,
      now,
    )
    expect(result).toEqual({ fired: false, reason: 'delivery_failed' })
    expect(restores).toHaveLength(1)
    expect(restores[0]?.[1]).toBe(previousFiredAt)
  })

  it('keeps the cooldown claim when dispatch succeeds', async () => {
    vi.mocked(dispatchMcpEventToWebhook).mockReset()
    vi.mocked(dispatchMcpEventToWebhook).mockResolvedValueOnce(true)
    const { pg, restores } = mockPg(true)
    const result = await evaluateMcpFailureSpikeSubscriptionFromMetrics(
      c,
      pg,
      baseWebhook,
      baseArgs,
      thresholds,
      metrics,
      now,
    )
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('triggered')
    expect(restores).toHaveLength(0)
  })
})
