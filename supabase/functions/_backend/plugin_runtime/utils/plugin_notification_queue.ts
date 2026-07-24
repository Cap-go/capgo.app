import type { Context } from 'hono'
import type { EmailPreferenceKey, NotificationAudience } from './org_email_notifications.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

export const PLUGIN_NOTIFICATION_QUEUE_PREFIX = 'plugin:notif:v1:'
export const PLUGIN_NOTIFICATION_THROTTLE_PREFIX = 'plugin:notif:throttle:v1:'
const PLUGIN_NOTIFICATION_QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60
const PLUGIN_NOTIFICATION_QUEUE_MIN_TTL_SECONDS = 60
const PLUGIN_NOTIFICATION_QUEUE_CACHE_PATH = '/.plugin-notification-queue'
const PLUGIN_NOTIFICATION_QUEUE_CACHE_TTL_SECONDS = 60
export interface PluginOrgNotificationQueueItem {
  type: 'org'
  eventName: string
  eventData: Record<string, any>
  orgId: string
  uniqId: string
  cron: string
  managementEmail: string
  enqueuedAt: string
}

export interface PluginOrgMembersNotificationQueueItem {
  type: 'org_members'
  eventName: string
  preferenceKey: EmailPreferenceKey
  eventData: Record<string, any>
  orgId: string
  uniqId: string
  cron: string
  audience: NotificationAudience
  enqueuedAt: string
}

export type PluginOrgNotificationQueueInput = Omit<PluginOrgNotificationQueueItem, 'enqueuedAt'>
export type PluginOrgMembersNotificationQueueInput = Omit<PluginOrgMembersNotificationQueueItem, 'enqueuedAt'>
export type PluginNotificationQueueItem = PluginOrgNotificationQueueItem | PluginOrgMembersNotificationQueueItem
export type PluginNotificationQueueInput = PluginOrgNotificationQueueInput | PluginOrgMembersNotificationQueueInput

function getStore(c: Context) {
  return c.env.PLUGIN_NOTIFICATION_QUEUE ?? null
}

async function sha256Hex(value: string) {
  const encoded = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function buildQueueKey(item: PluginNotificationQueueInput) {
  const uniqHash = await sha256Hex(item.uniqId)
  return `${PLUGIN_NOTIFICATION_QUEUE_PREFIX}${item.type}:${encodeURIComponent(item.orgId)}:${encodeURIComponent(item.eventName)}:${uniqHash}`
}

export function buildPluginNotificationThrottleKey(queueKey: string) {
  const suffix = queueKey.startsWith(PLUGIN_NOTIFICATION_QUEUE_PREFIX)
    ? queueKey.slice(PLUGIN_NOTIFICATION_QUEUE_PREFIX.length)
    : encodeURIComponent(queueKey)
  return `${PLUGIN_NOTIFICATION_THROTTLE_PREFIX}${suffix}`
}

export async function suppressPluginNotificationQueue(store: KVNamespace, queueKey: string, ttlSeconds: number) {
  const boundedTtlSeconds = Math.max(PLUGIN_NOTIFICATION_QUEUE_MIN_TTL_SECONDS, Math.min(ttlSeconds, PLUGIN_NOTIFICATION_QUEUE_TTL_SECONDS))
  await store.put(buildPluginNotificationThrottleKey(queueKey), new Date().toISOString(), { expirationTtl: boundedTtlSeconds })
}

async function getQueueCache(c: Context, key: string) {
  const helper = new CacheHelper(c)
  const request = helper.buildRequest(PLUGIN_NOTIFICATION_QUEUE_CACHE_PATH, { key })
  const cached = await helper.matchJson<{ queued: boolean }>(request)
  return {
    hit: cached?.queued === true,
    markQueued: () => helper.putJson(request, { queued: true }, PLUGIN_NOTIFICATION_QUEUE_CACHE_TTL_SECONDS),
  }
}

async function enqueuePluginNotification(c: Context, item: PluginNotificationQueueInput): Promise<boolean> {
  const store = getStore(c)
  if (!store) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification KV queue missing', type: item.type, eventName: item.eventName, orgId: item.orgId })
    return false
  }

  const key = await buildQueueKey(item)
  const queueCache = await getQueueCache(c, key)
  if (queueCache.hit) {
    cloudlog({ requestId: c.get('requestId'), message: 'Plugin notification queue cache hit', key, type: item.type, eventName: item.eventName, orgId: item.orgId })
    return true
  }

  try {
    const throttled = await store.get(buildPluginNotificationThrottleKey(key))
    if (throttled) {
      await queueCache.markQueued()
      cloudlog({ requestId: c.get('requestId'), message: 'Plugin notification queue throttle hit', key, type: item.type, eventName: item.eventName, orgId: item.orgId })
      return true
    }

    const existing = await store.get(key)
    if (existing) {
      await queueCache.markQueued()
      cloudlog({ requestId: c.get('requestId'), message: 'Plugin notification already queued', key, type: item.type, eventName: item.eventName, orgId: item.orgId })
      return true
    }

    const payload = {
      ...item,
      enqueuedAt: new Date().toISOString(),
    }
    await store.put(key, JSON.stringify(payload), { expirationTtl: PLUGIN_NOTIFICATION_QUEUE_TTL_SECONDS })
    await queueCache.markQueued()
    cloudlog({ requestId: c.get('requestId'), message: 'Plugin notification queued', key, type: item.type, eventName: item.eventName, orgId: item.orgId })
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Plugin notification KV queue failed', key, type: item.type, eventName: item.eventName, orgId: item.orgId, error: serializeError(error) })
    return false
  }
}

export function queuePluginOrgNotification(
  c: Context,
  eventName: string,
  eventData: Record<string, any>,
  orgId: string,
  uniqId: string,
  cron: string,
  managementEmail: string,
) {
  return enqueuePluginNotification(c, {
    type: 'org',
    eventName,
    eventData,
    orgId,
    uniqId,
    cron,
    managementEmail,
  })
}

type PluginOrgMembersNotificationQueueOptions = Omit<PluginOrgMembersNotificationQueueInput, 'type'>

export function queuePluginOrgMembersNotification(
  c: Context,
  options: PluginOrgMembersNotificationQueueOptions,
) {
  return enqueuePluginNotification(c, {
    type: 'org_members',
    ...options,
  })
}

export function parsePluginNotificationQueueItem(c: Context, key: string, raw: string): PluginNotificationQueueItem | null {
  try {
    const item = JSON.parse(raw) as PluginNotificationQueueItem
    if (item.type === 'org' && item.eventName && item.orgId && item.uniqId && item.cron && item.managementEmail)
      return item
    if (item.type === 'org_members' && item.eventName && item.preferenceKey && item.orgId && item.uniqId && item.cron && item.audience)
      return item
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid plugin notification queue item', key, error: serializeError(error) })
  }
  return null
}
