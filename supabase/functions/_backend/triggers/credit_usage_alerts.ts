import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { sendNotifToOrgMembers } from '../utils/org_email_notifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { sendEventToTracking } from '../utils/tracking.ts'

interface CreditUsageAlertPayload {
  org_id: string
  threshold: number
  percent_used?: number
  total_credits?: number
  available_credits?: number
  alert_cycle?: number
  transaction_id?: number
}

const EVENT_BY_THRESHOLD: Record<number, string> = {
  50: 'org:credits_usage_50_percent',
  75: 'org:credits_usage_75_percent',
  90: 'org:credits_usage_90_percent',
  100: 'org:credits_usage_100_percent',
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const payload = await parseBody<CreditUsageAlertPayload>(c)
  const threshold = Number(payload.threshold)
  const orgId = payload.org_id

  if (!orgId || Number.isNaN(threshold))
    throw simpleError('invalid_payload', 'Missing orgId or threshold in alert payload', { payload })

  const eventName = EVENT_BY_THRESHOLD[threshold]
  if (!eventName)
    throw simpleError('unsupported_threshold', 'Threshold not supported', { threshold, payload })

  const percentUsed = Math.min(
    100,
    Math.trunc(Number(payload.percent_used ?? 0)),
  )
  const totalCredits = Number(payload.total_credits ?? 0)
  const availableCredits = Number(payload.available_credits ?? 0)
  const alertCycle = Number(payload.alert_cycle ?? 1)

  const uniqId = `${alertCycle}:${threshold}`
  const metadata = {
    percent: percentUsed,
    total_credits: totalCredits,
    available_credits: availableCredits,
    alert_cycle: alertCycle,
    transaction_id: payload.transaction_id,
    threshold,
  }

  const pgClient = getPgClient(c, true)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const sent = await sendNotifToOrgMembers(
      c,
      eventName,
      'credit_usage',
      metadata,
      orgId,
      uniqId,
      '0 0 1 * *',
      drizzleClient,
    )

    if (sent) {
      cloudlog({ requestId: c.get('requestId'), message: 'credit usage alert sent', eventName, orgId, metadata })
      await sendEventToTracking(c, {
        channel: 'usage',
        event: `Credit usage ${threshold}%+`,
        user_id: orgId,
        groups: { organization: orgId },
        tags: {
          alert_cycle: alertCycle.toString(),
          percent_used: percentUsed.toFixed(2),
          threshold: threshold.toString(),
        },
      }).catch()
    }
    else {
      cloudlog({ requestId: c.get('requestId'), message: 'credit usage alert skipped', eventName, orgId, metadata })
    }

    return c.json(BRES)
  }
  finally {
    closeClient(c, pgClient)
  }
})
