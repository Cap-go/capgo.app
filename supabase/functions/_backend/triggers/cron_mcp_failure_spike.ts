import type {
  FailureSpikeMetrics,
  McpFailureSpikeWebhookRow,
} from '../utils/mcp_failure_spike_runner.ts'
import { BRES, createHono, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import {
  evaluateMcpFailureSpikeSubscriptions,
  gatherFailureSpikeMetrics,
} from '../utils/mcp_failure_spike_runner.ts'
import { mcpFailureSpikeArgumentsSchema, resolveFailureSpikeThresholds } from '../utils/mcp_failure_spike_policy.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)

const SUBSCRIPTION_PAGE_SIZE = 200
// Queue consumer uses a 15s HTTP timeout for cron handlers; stay under it.
const EVALUATION_BUDGET_MS = 12_000
const EVALUATION_CONCURRENCY = 8
const METRICS_KEY_SEP = '\u0001'

async function loadMcpFailureSpikeSubscriptions(pg: Awaited<ReturnType<typeof getPgClient>>) {
  const webhooks: McpFailureSpikeWebhookRow[] = []
  let page = 0

  while (true) {
    const { rows } = await pg.query<McpFailureSpikeWebhookRow>(
      `
      SELECT
        id,
        org_id,
        secret,
        url,
        enabled,
        source,
        mcp_event,
        mcp_arguments,
        mcp_verified_at,
        expires_at,
        mcp_spike_last_fired_at
      FROM public.webhooks
      WHERE source = 'mcp'
        AND enabled = true
        AND mcp_event = 'update.failure_spike'
        AND mcp_verified_at IS NOT NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY id ASC
      LIMIT $1 OFFSET $2
      `,
      [SUBSCRIPTION_PAGE_SIZE, page * SUBSCRIPTION_PAGE_SIZE],
    )
    webhooks.push(...rows)
    if (rows.length < SUBSCRIPTION_PAGE_SIZE)
      break
    page += 1
  }

  return webhooks
}

function metricsGroupKey(appId: string, channel: string | undefined, windowMinutes: number) {
  return `${appId}${METRICS_KEY_SEP}${channel ?? ''}${METRICS_KEY_SEP}${windowMinutes}`
}

type MetricsGroup = {
  appId: string
  channel?: string
  windowMinutes: number
  webhooks: McpFailureSpikeWebhookRow[]
}

async function runWithDeadline<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  options: { concurrency: number, deadline: number, now?: () => number },
) {
  const now = options.now ?? Date.now
  let next = 0
  const runners = Array.from({ length: Math.min(options.concurrency, items.length) }, async () => {
    while (next < items.length && now() < options.deadline) {
      const item = items[next++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

async function loadAppOwnerOrgs(
  pg: Awaited<ReturnType<typeof getPgClient>>,
  appIds: string[],
) {
  const owners = new Map<string, string>()
  if (appIds.length === 0)
    return owners

  const { rows } = await pg.query<{ app_id: string, owner_org: string }>(
    'SELECT app_id, owner_org::text AS owner_org FROM public.apps WHERE app_id = ANY($1::text[])',
    [appIds],
  )
  for (const row of rows)
    owners.set(row.app_id, row.owner_org)
  return owners
}

function buildMetricsGroups(webhooks: McpFailureSpikeWebhookRow[]): MetricsGroup[] {
  const groupMap = new Map<string, MetricsGroup>()

  for (const webhook of webhooks) {
    const args = (webhook.mcp_arguments && typeof webhook.mcp_arguments === 'object' && !Array.isArray(webhook.mcp_arguments))
      ? webhook.mcp_arguments as Record<string, unknown>
      : {}
    const parsed = mcpFailureSpikeArgumentsSchema.safeParse(args)
    if (!parsed.success)
      continue

    const thresholds = resolveFailureSpikeThresholds(args)
    const key = metricsGroupKey(parsed.data.app_id, parsed.data.channel, thresholds.window_minutes)
    const existing = groupMap.get(key)
    if (existing)
      existing.webhooks.push(webhook)
    else
      groupMap.set(key, {
        appId: parsed.data.app_id,
        channel: parsed.data.channel,
        windowMinutes: thresholds.window_minutes,
        webhooks: [webhook],
      })
  }

  return [...groupMap.values()]
}

app.post('/', middlewareAPISecret, async (c) => {
  const pg = await getPgClient(c)
  try {
    const now = new Date()
    const deadline = Date.now() + EVALUATION_BUDGET_MS
    const webhooks = await loadMcpFailureSpikeSubscriptions(pg)
    const groups = buildMetricsGroups(webhooks)
    const appIds = [...new Set(groups.map(group => group.appId))]
    const appOwnerOrgByAppId = await loadAppOwnerOrgs(pg, appIds)

    let checked = 0
    let fired = 0
    const metricsCache = new Map<string, FailureSpikeMetrics>()

    await runWithDeadline(groups, async (group) => {
      const key = metricsGroupKey(group.appId, group.channel, group.windowMinutes)
      let metrics = metricsCache.get(key)
      if (!metrics) {
        metrics = await gatherFailureSpikeMetrics(c, group.appId, group.channel, group.windowMinutes, now)
        metricsCache.set(key, metrics)
      }

      for (const webhook of group.webhooks) {
        if (Date.now() >= deadline)
          return
        try {
          const result = await evaluateMcpFailureSpikeSubscriptions(
            c,
            pg,
            webhook,
            now,
            appOwnerOrgByAppId,
            metrics,
          )
          checked += 1
          if (result.fired)
            fired += 1
        }
        catch (error) {
          cloudlogErr({
            requestId: c.get('requestId'),
            message: 'MCP failure spike evaluation failed',
            webhookId: webhook.id,
            error,
          })
        }
      }
    }, { concurrency: EVALUATION_CONCURRENCY, deadline })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'MCP failure spike cron finished',
      checked,
      fired,
      groups: groups.length,
    })
    return c.json({ ...BRES, checked, fired })
  }
  finally {
    closeClient(c, pg)
  }
})
