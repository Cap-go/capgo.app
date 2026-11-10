import type { WebhookRow } from '../utils/mcp_failure_spike_runner.ts'
import { BRES, createHono, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { evaluateMcpFailureSpikeSubscriptions } from '../utils/mcp_failure_spike_runner.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)

const SUBSCRIPTION_PAGE_SIZE = 200

async function loadMcpFailureSpikeSubscriptions(pg: Awaited<ReturnType<typeof getPgClient>>) {
  const webhooks: WebhookRow[] = []
  let page = 0

  while (true) {
    const { rows } = await pg.query<WebhookRow>(
      `
      SELECT *
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

app.post('/', middlewareAPISecret, async (c) => {
  const pg = await getPgClient(c)
  try {
    const now = new Date()
    const webhooks = await loadMcpFailureSpikeSubscriptions(pg)
    let checked = 0
    let fired = 0

    for (const webhook of webhooks) {
      try {
        const result = await evaluateMcpFailureSpikeSubscriptions(c, pg, webhook, now)
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

    cloudlog({
      requestId: c.get('requestId'),
      message: 'MCP failure spike cron finished',
      checked,
      fired,
    })
    return c.json({ ...BRES, checked, fired })
  }
  finally {
    closeClient(c, pg)
  }
})
