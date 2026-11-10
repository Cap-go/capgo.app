import type { Context } from 'hono'
import type { PgClient } from './pg.ts'
import type { Database } from './supabase.types.ts'
import type { McpEventName } from './mcp_events.ts'
import { PUBLIC_FAILURE_ACTIONS } from './cloudflare.ts'
import { cloudlog } from './logging.ts'
import {
  evaluateFailureSpike,
  mcpFailureSpikeArgumentsSchema,
  resolveFailureSpikeThresholds,
} from './mcp_failure_spike_policy.ts'
import { dispatchMcpEvent } from './mcp_events.ts'
import { readStatsInsights, readStatsVersion } from './stats.ts'

export type WebhookRow = Database['public']['Tables']['webhooks']['Row']

export async function gatherFailureSpikeMetrics(
  c: Context,
  appId: string,
  channelName: string | undefined,
  windowMinutes: number,
  now: Date,
) {
  const start = new Date(now.getTime() - windowMinutes * 60 * 1000).toISOString()
  const end = now.toISOString()
  const channel = channelName ? { name: channelName } : undefined

  const versionStats = await readStatsVersion(c, appId, start, end, channel)
  let checks = 0
  let failures = 0
  let version = 'unknown'
  let maxInstall = 0
  for (const row of versionStats) {
    const install = Number(row.install ?? 0)
    const fail = Number(row.fail ?? 0)
    checks += install + fail
    failures += fail
    if (install > maxInstall) {
      maxInstall = install
      version = row.version_name
    }
  }

  const insights = await readStatsInsights(c, {
    app_id: appId,
    start_date: start,
    end_date: end,
    actions: [...PUBLIC_FAILURE_ACTIONS],
  })

  const topFailureActionCodes = insights.actions
    .filter(entry => (PUBLIC_FAILURE_ACTIONS as readonly string[]).includes(entry.action))
    .sort((left, right) => right.total - left.total)
    .slice(0, 5)
    .map(entry => ({ action: entry.action, count: entry.total }))

  return { checks, failures, version, topFailureActionCodes, windowStart: start, windowEnd: end }
}

export async function evaluateMcpFailureSpikeSubscriptions(
  c: Context,
  pg: PgClient,
  webhook: WebhookRow,
  now: Date,
): Promise<{ fired: boolean, reason: string }> {
  const args = (webhook.mcp_arguments && typeof webhook.mcp_arguments === 'object' && !Array.isArray(webhook.mcp_arguments))
    ? webhook.mcp_arguments as Record<string, unknown>
    : {}

  const parsed = mcpFailureSpikeArgumentsSchema.safeParse(args)
  if (!parsed.success)
    return { fired: false, reason: 'invalid_arguments' }

  const thresholds = resolveFailureSpikeThresholds(args)
  const metrics = await gatherFailureSpikeMetrics(
    c,
    parsed.data.app_id,
    parsed.data.channel,
    thresholds.window_minutes,
    now,
  )

  const evaluation = evaluateFailureSpike({
    failures: metrics.failures,
    checks: metrics.checks,
    thresholds,
    lastFiredAt: webhook.mcp_spike_last_fired_at,
    now,
  })

  if (!evaluation.shouldFire)
    return { fired: false, reason: evaluation.reason }

  const data: Record<string, unknown> = {
    org_id: webhook.org_id,
    app_id: parsed.data.app_id,
    version: metrics.version,
    failures: metrics.failures,
    checks: metrics.checks,
    rate_percent: evaluation.observedRatePercent,
    window_minutes: thresholds.window_minutes,
    thresholds,
    top_failure_action_codes: metrics.topFailureActionCodes,
    window_start: metrics.windowStart,
    window_end: metrics.windowEnd,
  }
  if (parsed.data.channel)
    data.channel = parsed.data.channel

  await pg.query(
    'UPDATE public.webhooks SET mcp_spike_last_fired_at = $2 WHERE id = $1',
    [webhook.id, now.toISOString()],
  )

  const eventName = 'update.failure_spike' as McpEventName
  await dispatchMcpEvent(c, webhook.org_id, eventName, data)

  cloudlog({
    requestId: c.get('requestId'),
    message: 'MCP failure spike event dispatched',
    webhookId: webhook.id,
    appId: parsed.data.app_id,
  })

  return { fired: true, reason: evaluation.reason }
}
