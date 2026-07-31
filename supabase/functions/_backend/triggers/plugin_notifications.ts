import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PluginNotificationQueueItem } from '../utils/plugin_notification_queue.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { sendNotifOrg } from '../utils/notifications.ts'
import { sendNotifToOrgMembersOnce } from '../utils/org_email_notifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'

const MAX_PLUGIN_NOTIFICATION_BATCH = 100

interface PluginNotificationBatchBody {
  items?: PluginNotificationQueueItem[]
}

function isValidPluginNotificationItem(item: unknown): item is PluginNotificationQueueItem {
  if (!item || typeof item !== 'object')
    return false

  const value = item as Partial<PluginNotificationQueueItem>
  if (value.type === 'org') {
    return Boolean(value.eventName && value.orgId && value.uniqId && value.cron && value.managementEmail && value.eventData)
  }
  if (value.type === 'org_members') {
    return Boolean(value.eventName && value.preferenceKey && value.orgId && value.uniqId && value.cron && value.audience && value.eventData)
  }
  return false
}

type PluginNotificationSendResult = boolean | { sent: false, lastSendAt: string }
export type PluginNotificationItemResult = { status: 'delivered' } | { status: 'failed' } | { lastSendAt: string, status: 'throttled' }

function getPluginNotificationItemResult(result: PluginNotificationSendResult): PluginNotificationItemResult {
  if (result === true)
    return { status: 'delivered' }
  if (typeof result === 'object' && result.sent === false && result.lastSendAt)
    return { status: 'throttled', lastSendAt: result.lastSendAt }
  return { status: 'failed' }
}

async function sendQueuedPluginNotification(c: Context, item: PluginNotificationQueueItem, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<PluginNotificationSendResult> {
  if (item.type === 'org')
    return await sendNotifOrg(c, item.eventName, item.eventData, item.orgId, item.uniqId, item.cron, item.managementEmail, drizzleClient)

  return await sendNotifToOrgMembersOnce(c, item.eventName, item.preferenceKey, item.eventData, item.orgId, item.uniqId, drizzleClient, item.audience)
}

async function processPluginNotifications(c: Context, items: PluginNotificationQueueItem[]) {
  const pgClient = getPgClient(c, true)
  const drizzleClient = getDrizzleClient(pgClient)
  const results: PluginNotificationItemResult[] = []
  let processed = 0
  let failed = 0
  let throttled = 0

  try {
    for (const item of items) {
      try {
        const result = getPluginNotificationItemResult(await sendQueuedPluginNotification(c, item, drizzleClient))
        results.push(result)
        if (result.status === 'failed') {
          failed++
          cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification item was not delivered', type: item.type, eventName: item.eventName, orgId: item.orgId })
          continue
        }
        if (result.status === 'throttled')
          throttled++
        processed++
      }
      catch (error) {
        failed++
        results.push({ status: 'failed' })
        cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification item processing failed', type: item.type, eventName: item.eventName, orgId: item.orgId, error: serializeError(error) })
      }
    }
  }
  finally {
    await closeClient(c, pgClient)
  }

  return { processed, failed, throttled, results }
}

export interface PluginNotificationDeliveryResult {
  processed: number
  failed: number
  throttled: number
  invalid: number
  results: PluginNotificationItemResult[]
}

export async function deliverQueuedPluginNotifications(
  c: Context,
  rawItems: PluginNotificationQueueItem[],
): Promise<PluginNotificationDeliveryResult> {
  if (rawItems.length > MAX_PLUGIN_NOTIFICATION_BATCH)
    throw simpleError('too_many_items', 'Too many plugin notification items', { max: MAX_PLUGIN_NOTIFICATION_BATCH, count: rawItems.length })

  const items = rawItems.filter(isValidPluginNotificationItem)
  const invalid = rawItems.length - items.length
  if (invalid > 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'Plugin notification batch contained invalid items', invalid })
  }
  if (items.length === 0)
    return { processed: 0, failed: 0, throttled: 0, invalid, results: [] }

  const result = await processPluginNotifications(c, items)
  return { ...result, invalid }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<PluginNotificationBatchBody>(c)
  const rawItems = Array.isArray(body.items) ? body.items : []
  if (rawItems.length === 0)
    return c.json({ ...BRES, processed: 0, failed: 0, throttled: 0, results: [], invalid: 0 })

  const result = await deliverQueuedPluginNotifications(c, rawItems)
  if (result.failed > 0) {
    throw quickError(500, 'plugin_notification_batch_failed', 'Plugin notification batch failed', { ...result }, undefined, { alert: false })
  }
  return c.json({ ...BRES, ...result })
})
