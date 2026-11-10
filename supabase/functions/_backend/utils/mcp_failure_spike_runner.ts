import type { Context } from 'hono'
import type { PgClient } from './pg.ts'
import type { McpEventName } from './mcp_events.ts'
import { PUBLIC_FAILURE_ACTIONS } from './cloudflare.ts'
import { cloudlog } from './logging.ts'
import {
  evaluateFailureSpike,
  mcpFailureSpikeArgumentsSchema,
  resolveFailureSpikeThresholds,
  type McpFailureSpikeThresholds,
} from './mcp_failure_spike_policy.ts'
import { dispatchMcpEventToWebhook, type McpDeliverableWebhookRow } from './mcp_events.ts'
import { readStatsInsights, readStatsVersion } from './stats.ts'

export type McpFailureSpikeWebhookRow = McpDeliverableWebhookRow & {
  id: number
  org_id: string
  secret: string
  url: string
  mcp_arguments: Record<string, unknown> | null
  mcp_spike_last_fired_at: string | null
}

export type FailureSpikeMetrics = {
  checks: number
  failures: number
  version: string
  topFailureActionCodes: { action: string, count: number }[]
  windowStart: string
  windowEnd: string
}

export async function gatherFailureSpikeMetrics(
  c: Context,
  appId: string,
  channelName: string | undefined,
  windowMinutes: number,
  now: Date,
): Promise<FailureSpikeMetrics> {
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

  let topFailureActionCodes: FailureSpikeMetrics['topFailureActionCodes'] = []
  if (!channelName) {
    const insightsParams = {
      app_id: appId,
      start_date: start,
      end_date: end,
      actions: [...PUBLIC_FAILURE_ACTIONS],
      ...(version !== 'unknown' ? { version_name: version } : {}),
    }
    const insights = await readStatsInsights(c, insightsParams)
    topFailureActionCodes = insights.actions
      .filter(entry => (PUBLIC_FAILURE_ACTIONS as readonly string[]).includes(entry.action))
      .sort((left, right) => right.total - left.total)
      .slice(0, 5)
      .map(entry => ({ action: entry.action, count: entry.total }))
  }

  return { checks, failures, version, topFailureActionCodes, windowStart: start, windowEnd: end }
}

export async function evaluateMcpFailureSpikeSubscriptions(
  c: Context,
  pg: PgClient,
  webhook: McpFailureSpikeWebhookRow,
  now: Date,
  metricsOverride?: FailureSpikeMetrics,
  appOwnerOrgByAppId?: ReadonlyMap<string, string>,
): Promise<{ fired: boolean, reason: string }> {
  const args = (webhook.mcp_arguments && typeof webhook.mcp_arguments === 'object' && !Array.isArray(webhook.mcp_arguments))
    ? webhook.mcp_arguments as Record<string, unknown>
    : {}

  const parsed = mcpFailureSpikeArgumentsSchema.safeParse(args)
  if (!parsed.success)
    return { fired: false, reason: 'invalid_arguments' }

  const ownerOrg = appOwnerOrgByAppId?.get(parsed.data.app_id)
  if (appOwnerOrgByAppId && (!ownerOrg || ownerOrg !== webhook.org_id))
    return { fired: false, reason: 'invalid_arguments' }

  const thresholds = resolveFailureSpikeThresholds(args)
  const metrics = metricsOverride ?? await gatherFailureSpikeMetrics(
    c,
    parsed.data.app_id,
    parsed.data.channel,
    thresholds.window_minutes,
    now,
  )

  return evaluateMcpFailureSpikeSubscriptionFromMetrics(
    c,
    pg,
    webhook,
    parsed.data,
    thresholds,
    metrics,
    now,
  )
}

export async function evaluateMcpFailureSpikeSubscriptionFromMetrics(
  c: Context,
  pg: PgClient,
  webhook: McpFailureSpikeWebhookRow,
  subscriptionArgs: { app_id: string, channel?: string },
  thresholds: McpFailureSpikeThresholds,
  metrics: FailureSpikeMetrics,
  now: Date,
): Promise<{ fired: boolean, reason: string }> {
  const evaluation = evaluateFailureSpike({
    failures: metrics.failures,
    checks: metrics.checks,
    thresholds,
    lastFiredAt: webhook.mcp_spike_last_fired_at,
    now,
  })

  if (!evaluation.shouldFire)
    return { fired: false, reason: evaluation.reason }

  const cooldownDeadline = new Date(now.getTime() - thresholds.cooldown_minutes * 60 * 1000)
  const previousFiredAt = webhook.mcp_spike_last_fired_at

  const claim = await pg.query<{ id: number }>(
    `
    UPDATE public.webhooks
    SET mcp_spike_last_fired_at = $2::timestamptz
    WHERE id = $1
      AND (
        mcp_spike_last_fired_at IS NULL
        OR mcp_spike_last_fired_at <= $3::timestamptz
      )
    RETURNING id
    `,
    [webhook.id, now.toISOString(), cooldownDeadline.toISOString()],
  )
  if (claim.rows.length === 0)
    return { fired: false, reason: 'cooldown' }

  const data: Record<string, unknown> = {
    org_id: webhook.org_id,
    app_id: subscriptionArgs.app_id,
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
  if (subscriptionArgs.channel)
    data.channel = subscriptionArgs.channel

  const eventName = 'update.failure_spike' as McpEventName
  const delivered = await dispatchMcpEventToWebhook(c, webhook, eventName, data)
  if (!delivered) {
    await pg.query(
      'UPDATE public.webhooks SET mcp_spike_last_fired_at = $2::timestamptz WHERE id = $1',
      [webhook.id, previousFiredAt],
    )
    return { fired: false, reason: 'delivery_failed' }
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'MCP failure spike event dispatched',
    webhookId: webhook.id,
    appId: subscriptionArgs.app_id,
  })

  return { fired: true, reason: evaluation.reason }
}
