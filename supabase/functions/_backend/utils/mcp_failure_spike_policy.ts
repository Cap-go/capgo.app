import { z } from 'zod'

export const MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS = {
  min_failures: 10,
  failure_rate_percent: 10,
  min_checks: 50,
  window_minutes: 15,
  cooldown_minutes: 60,
} as const

export type McpFailureSpikeThresholds = {
  min_failures: number
  failure_rate_percent: number
  min_checks: number
  window_minutes: number
  cooldown_minutes: number
}

const optionalThresholdFields = {
  min_failures: z.number().int().min(1).optional(),
  failure_rate_percent: z.number().min(1).max(100).optional(),
  min_checks: z.number().int().min(1).optional(),
  window_minutes: z.number().int().min(5).max(1440).optional(),
  cooldown_minutes: z.number().int().min(5).max(1440).optional(),
}

export const mcpFailureSpikeArgumentsSchema = z.object({
  org_id: z.string().uuid(),
  app_id: z.string().min(1),
  channel: z.string().min(1).optional(),
  ...optionalThresholdFields,
}).strict().superRefine((data, ctx) => {
  const cooldown = data.cooldown_minutes ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.cooldown_minutes
  const window = data.window_minutes ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.window_minutes
  if (cooldown < window) {
    ctx.addIssue({
      code: 'custom',
      message: 'cooldown_minutes must be greater than or equal to window_minutes',
      path: ['cooldown_minutes'],
    })
  }
})

export function formatFailureSpikeValidationError(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')
}

export function resolveFailureSpikeThresholds(
  args: Record<string, unknown>,
): McpFailureSpikeThresholds {
  const parsed = mcpFailureSpikeArgumentsSchema.safeParse(args)
  if (!parsed.success)
    throw new Error(formatFailureSpikeValidationError(parsed.error))
  const data = parsed.data
  return {
    min_failures: data.min_failures ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.min_failures,
    failure_rate_percent: data.failure_rate_percent ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.failure_rate_percent,
    min_checks: data.min_checks ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.min_checks,
    window_minutes: data.window_minutes ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.window_minutes,
    cooldown_minutes: data.cooldown_minutes ?? MCP_FAILURE_SPIKE_RECOMMENDED_DEFAULTS.cooldown_minutes,
  }
}

export function evaluateFailureSpike(input: {
  failures: number
  checks: number
  thresholds: McpFailureSpikeThresholds
  lastFiredAt?: Date | string | null
  now?: Date
}): {
  shouldFire: boolean
  reason: 'below_min_checks' | 'below_min_failures' | 'below_rate' | 'cooldown' | 'triggered'
  observedRatePercent: number
} {
  const now = input.now ?? new Date()
  const failures = Math.max(0, Math.floor(input.failures))
  const checks = Math.max(0, Math.floor(input.checks))
  const { min_failures: minFailures, failure_rate_percent: ratePercent, min_checks: minChecks, cooldown_minutes: cooldownMinutes } = input.thresholds
  const observedRatePercent = checks > 0 ? (failures / checks) * 100 : 0

  if (checks < minChecks)
    return { shouldFire: false, reason: 'below_min_checks', observedRatePercent }

  if (failures < minFailures)
    return { shouldFire: false, reason: 'below_min_failures', observedRatePercent }

  if (observedRatePercent < ratePercent)
    return { shouldFire: false, reason: 'below_rate', observedRatePercent }

  const lastFired = input.lastFiredAt
    ? (input.lastFiredAt instanceof Date ? input.lastFiredAt : new Date(input.lastFiredAt))
    : null
  if (lastFired && !Number.isNaN(lastFired.getTime())) {
    const cooldownMs = cooldownMinutes * 60 * 1000
    if (cooldownMs > 0 && lastFired.getTime() + cooldownMs > now.getTime())
      return { shouldFire: false, reason: 'cooldown', observedRatePercent }
  }

  return { shouldFire: true, reason: 'triggered', observedRatePercent }
}
