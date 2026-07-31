import type { Context } from 'hono'
import type { PluginNotificationQueueItem } from './plugin_notification_queue.ts'
import { parseCronExpression } from 'cron-schedule'
import { deliverQueuedPluginNotifications } from '../triggers/plugin_notifications.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { parsePluginNotificationQueueItem, PLUGIN_NOTIFICATION_QUEUE_PREFIX, suppressPluginNotificationQueue } from './plugin_notification_queue.ts'
import { getEnv } from './utils.ts'

const PLUGIN_NOTIFICATION_FLUSH_LIMIT = 100
const PLUGIN_NOTIFICATION_PROCESSING_PREFIX = 'plugin:notif:processing:v1:'
const PLUGIN_NOTIFICATION_PROCESSING_TTL_SECONDS = 120
const PLUGIN_NOTIFICATION_THROTTLE_FALLBACK_TTL_SECONDS = 60
const PLUGIN_NOTIFICATION_THROTTLE_MIN_TTL_SECONDS = 60
const PLUGIN_NOTIFICATION_THROTTLE_MAX_TTL_SECONDS = 7 * 24 * 60 * 60

export interface PluginNotificationFlushResult {
  status: 'ok'
  scanned: number
  transferred: number
  deleted: number
  failed: number
}

interface PluginNotificationTriggerBody {
  results?: Array<{ lastSendAt?: string, status?: string }>
}

interface PluginNotificationTransferResult {
  accepted: boolean
  throttledLastSendAt?: string
}

function getPluginNotificationTriggerUrl(c: Context) {
  const cfUrl = getEnv(c, 'CLOUDFLARE_FUNCTION_URL')
  if (cfUrl)
    return `${cfUrl}/triggers/plugin_notifications`

  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  if (supabaseUrl)
    return `${supabaseUrl}/functions/v1/triggers/plugin_notifications`

  return null
}

function getPluginNotificationThrottleTtlSeconds(c: Context, item: PluginNotificationQueueItem, lastSendAt: string) {
  try {
    const interval = parseCronExpression(item.cron)
    const nextDate = interval.getNextDate(new Date(lastSendAt))
    const diffMs = nextDate.getTime() - Date.now()
    return Math.max(PLUGIN_NOTIFICATION_THROTTLE_MIN_TTL_SECONDS, Math.min(Math.ceil(diffMs / 1000), PLUGIN_NOTIFICATION_THROTTLE_MAX_TTL_SECONDS))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification throttle TTL calculation failed', type: item.type, eventName: item.eventName, orgId: item.orgId, error: serializeError(error) })
    return PLUGIN_NOTIFICATION_THROTTLE_FALLBACK_TTL_SECONDS
  }
}

async function postPluginNotificationBatch(c: Context, items: PluginNotificationQueueItem[]): Promise<PluginNotificationTransferResult> {
  // Cron flush runs on the API worker: deliver in-process to avoid brittle self-HTTP (prod 522s).
  if (c.get('deliverPluginNotificationsInProcess')) {
    const result = await deliverQueuedPluginNotifications(c, items)
    if (result.failed > 0) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Plugin notification in-process transfer failed',
        failed: result.failed,
        processed: result.processed,
        throttled: result.throttled,
        invalid: result.invalid,
      })
      return { accepted: false }
    }
    const throttledResult = result.results.find(entry => entry.status === 'throttled' && entry.lastSendAt)
    return { accepted: true, throttledLastSendAt: throttledResult?.lastSendAt }
  }

  const url = getPluginNotificationTriggerUrl(c)
  const apiSecret = getEnv(c, 'API_SECRET')
  if (!url || !apiSecret) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification trigger config missing', hasUrl: Boolean(url), hasApiSecret: Boolean(apiSecret) })
    return { accepted: false }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apisecret': apiSecret,
    },
    body: JSON.stringify({ items }),
  })

  if (response.ok) {
    const body = await response.json().catch(() => null) as PluginNotificationTriggerBody | null
    const throttledResult = body?.results?.find(result => result.status === 'throttled' && result.lastSendAt)
    return { accepted: true, throttledLastSendAt: throttledResult?.lastSendAt }
  }

  const body = await response.text().catch(() => '')
  cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification trigger transfer failed', url, status: response.status, statusText: response.statusText, body })
  return { accepted: false }
}

function buildProcessingKey(queueKey: string) {
  const suffix = queueKey.startsWith(PLUGIN_NOTIFICATION_QUEUE_PREFIX)
    ? queueKey.slice(PLUGIN_NOTIFICATION_QUEUE_PREFIX.length)
    : encodeURIComponent(queueKey)
  return `${PLUGIN_NOTIFICATION_PROCESSING_PREFIX}${suffix}`
}

async function reserveQueueItem(store: KVNamespace, queueKey: string) {
  const processingKey = buildProcessingKey(queueKey)
  const existingLock = await store.get(processingKey)
  if (existingLock)
    return null

  await store.put(processingKey, new Date().toISOString(), { expirationTtl: PLUGIN_NOTIFICATION_PROCESSING_TTL_SECONDS })
  return processingKey
}

async function releaseProcessingKeys(store: KVNamespace, processingKeys: string[]) {
  for (const key of processingKeys) {
    await store.delete(key)
  }
}

async function releaseProcessingKeysSafely(c: Context, store: KVNamespace, processingKeys: string[]) {
  try {
    await releaseProcessingKeys(store, processingKeys)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification queue lock release failed', error: serializeError(error) })
  }
}

async function processBatch(
  c: Context,
  store: KVNamespace,
  items: PluginNotificationQueueItem[],
  itemKeys: string[],
  processingKeys: string[],
): Promise<{ transferred: number, deleted: number, failed: number }> {
  let transferred = 0
  let deleted = 0
  let failed = 0
  for (const [index, item] of items.entries()) {
    const itemKey = itemKeys[index]!
    const processingKey = processingKeys[index]!

    try {
      const transfer = await postPluginNotificationBatch(c, [item])
      if (!transfer.accepted) {
        failed++
        await releaseProcessingKeysSafely(c, store, [processingKey])
        continue
      }

      if (transfer.throttledLastSendAt) {
        await suppressPluginNotificationQueue(
          store,
          itemKey,
          getPluginNotificationThrottleTtlSeconds(c, item, transfer.throttledLastSendAt),
        )
      }
      await store.delete(itemKey)
      deleted++
      transferred++
      await releaseProcessingKeysSafely(c, store, [processingKey])
    }
    catch (error) {
      failed++
      await releaseProcessingKeysSafely(c, store, [processingKey])
      cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification queue transfer failed', key: itemKey, error: serializeError(error) })
    }
  }

  return { transferred, deleted, failed }
}

export async function flushQueuedPluginNotifications(c: Context, limit = PLUGIN_NOTIFICATION_FLUSH_LIMIT): Promise<PluginNotificationFlushResult> {
  const store = c.env.PLUGIN_NOTIFICATION_QUEUE
  if (!store) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification KV queue missing during flush' })
    throw new Error('Plugin notification KV queue missing during flush')
  }

  let scanned = 0
  let transferred = 0
  let deleted = 0
  let failed = 0
  let cursor: string | undefined

  do {
    const remaining = limit - scanned
    if (remaining <= 0)
      break

    const listed = await store.list({
      prefix: PLUGIN_NOTIFICATION_QUEUE_PREFIX,
      cursor,
      limit: Math.min(100, remaining),
    })
    cursor = listed.cursor

    const items: PluginNotificationQueueItem[] = []
    const itemKeys: string[] = []
    const processingKeys: string[] = []
    for (const key of listed.keys) {
      scanned++
      const raw = await store.get(key.name)
      if (!raw) {
        await store.delete(key.name)
        deleted++
        continue
      }

      const item = parsePluginNotificationQueueItem(c, key.name, raw)
      if (!item) {
        await store.delete(key.name)
        deleted++
        continue
      }

      const processingKey = await reserveQueueItem(store, key.name)
      if (!processingKey)
        continue

      items.push(item)
      itemKeys.push(key.name)
      processingKeys.push(processingKey)
    }

    if (items.length > 0) {
      const result = await processBatch(c, store, items, itemKeys, processingKeys)
      transferred += result.transferred
      deleted += result.deleted
      failed += result.failed
    }

    if (listed.list_complete)
      break
  } while (cursor)

  cloudlog({ requestId: c.get('requestId'), message: 'Plugin notification queue flush finished', scanned, transferred, deleted, failed })
  return { status: 'ok', scanned, transferred, deleted, failed }
}
