import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { sendEventToTracking } from '../utils/tracking.ts'

type RetentionAlertType = 'bundles_deletion_warning' | 'app_deletion_warning'

interface CanceledOrgRetentionAlertPayload {
  org_id: string
  org_name?: string
  management_email?: string
  alert_type: RetentionAlertType
  access_end?: string
  days_until_deletion?: number
  app_ids?: string[]
}

const ALERT_CONFIG: Record<RetentionAlertType, {
  bentoEvent: string
  trackingEvent: string
  icon: string
}> = {
  bundles_deletion_warning: {
    bentoEvent: 'org:bundles_will_be_deleted',
    trackingEvent: 'Bundles will be deleted',
    icon: '📦',
  },
  app_deletion_warning: {
    bentoEvent: 'org:apps_will_be_deleted',
    trackingEvent: 'Apps will be deleted',
    icon: '🗑️',
  },
}

function accessEndDateKey(accessEnd: string | undefined): string {
  if (!accessEnd)
    return 'unknown'
  const parsed = new Date(accessEnd)
  if (Number.isNaN(parsed.getTime()))
    return accessEnd.slice(0, 10)
  return parsed.toISOString().slice(0, 10)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const payload = await parseBody<CanceledOrgRetentionAlertPayload>(c)
  const orgId = payload.org_id
  const alertType = payload.alert_type

  if (!orgId || !alertType)
    throw simpleError('invalid_payload', 'Missing org_id or alert_type in retention alert payload', { payload })

  const config = ALERT_CONFIG[alertType]
  if (!config)
    throw simpleError('unsupported_alert_type', 'Retention alert type not supported', { alertType, payload })

  const daysUntilDeletion = Number(payload.days_until_deletion ?? 5)
  const appIds = Array.isArray(payload.app_ids) ? payload.app_ids : []
  const accessEndKey = accessEndDateKey(payload.access_end)
  const uniqId = `retention:${alertType}:${accessEndKey}`

  const metadata = {
    org_id: orgId,
    org_name: payload.org_name ?? '',
    management_email: payload.management_email ?? '',
    alert_type: alertType,
    access_end: payload.access_end ?? '',
    days_until_deletion: daysUntilDeletion,
    app_ids: appIds,
    app_count: appIds.length,
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'canceled org retention alert',
    eventName: config.bentoEvent,
    orgId,
    metadata,
  })

  await sendEventToTracking(c, {
    bento: {
      once: true,
      data: metadata,
      event: config.bentoEvent,
      preferenceKey: 'usage_limit',
      uniqId,
      audience: 'billing',
    },
    channel: 'usage',
    event: config.trackingEvent,
    icon: config.icon,
    user_id: orgId,
    groups: { organization: orgId },
    notify: false,
    sentToBento: true,
    tags: {
      alert_type: alertType,
      days_until_deletion: String(daysUntilDeletion),
      app_count: String(appIds.length),
    },
  }, { background: false })

  return c.json(BRES)
})
