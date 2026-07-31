import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import { parseCronExpression } from 'cron-schedule'
import { and, eq } from 'drizzle-orm'
import { trackBentoEvent } from './bento.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
import { closeClient, getDrizzleClient as createDrizzleClient, getPgClient, logPgError } from './pg.ts'
import * as schema from './postgres_schema.ts'
import { logSkippedSupabaseWrite, shouldQueuePluginNotifications, shouldSkipSupabaseNotificationWrites } from './supabase_write_guard.ts'
import { backgroundTask } from './utils.ts'

interface EventData {
  [key: string]: any
}

export interface SendNotifOrgOnceResult {
  cleanupFailed: boolean
  sent: boolean
}

const NOTIF_CACHE_PATH = '/.notif-sendable'

interface NotifCachePayload {
  sendable: boolean
}

function buildNotifCacheRequest(c: Context, orgId: string, eventName: string, uniqId: string) {
  const helper = new CacheHelper(c)
  if (!helper.available)
    return null
  return {
    helper,
    request: helper.buildRequest(NOTIF_CACHE_PATH, { org_id: orgId, event: eventName, uniq_id: uniqId }),
  }
}

async function getNotifCacheStatus(c: Context, orgId: string, eventName: string, uniqId: string): Promise<boolean | null> {
  const cacheEntry = buildNotifCacheRequest(c, orgId, eventName, uniqId)
  if (!cacheEntry)
    return null
  const payload = await cacheEntry.helper.matchJson<NotifCachePayload>(cacheEntry.request)
  if (!payload)
    return null
  return payload.sendable
}

function setNotifCacheStatus(c: Context, orgId: string, eventName: string, uniqId: string, sendable: boolean, ttlSeconds: number) {
  return backgroundTask(c, async () => {
    const cacheEntry = buildNotifCacheRequest(c, orgId, eventName, uniqId)
    if (!cacheEntry)
      return
    await cacheEntry.helper.putJson(cacheEntry.request, { sendable }, ttlSeconds)
  })
}

/**
 * Calculate seconds until the next cron window opens based on last send time.
 */
function getSecondsUntilNextCronWindow(lastSendAt: string, cron: string): number {
  const interval = parseCronExpression(cron)
  const lastSendDate = new Date(lastSendAt)
  const now = new Date()
  const nextDate = interval.getNextDate(lastSendDate)
  const diffMs = nextDate.getTime() - now.getTime()
  // Return at least 1 second, and cap at reasonable max (1 week)
  return Math.max(1, Math.min(Math.ceil(diffMs / 1000), 604800))
}

function isSendable(c: Context, last: string, cron: string) {
  const interval = parseCronExpression(cron)
  const last_send_at = new Date(last)
  const now = new Date()
  const nextDate = interval.getNextDate(last_send_at)
  const sendable = now.getTime() > nextDate.getTime()
  cloudlog({ requestId: c.get('requestId'), message: 'isSendable', cron, last_send_at, nextDate, now, sendable })

  return sendable
  // return false
}

/**
 * Get notification from database using drizzle (read replica)
 */
async function getNotification(
  c: Context,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  orgId: string,
  eventName: string,
  uniqId: string,
): Promise<{ last_send_at: Date, total_send: number } | null | undefined> {
  try {
    const notif = await drizzleClient
      .select({
        last_send_at: schema.notifications.last_send_at,
        total_send: schema.notifications.total_send,
      })
      .from(schema.notifications)
      .where(and(
        eq(schema.notifications.owner_org, orgId),
        eq(schema.notifications.event, eventName),
        eq(schema.notifications.uniq_id, uniqId),
      ))
      .limit(1)
      .then(data => data[0])

    return notif ?? null
  }
  catch (e: unknown) {
    logPgError(c, 'getNotification', e)
    return undefined
  }
}

export async function hasNotifOrgClaim(
  c: Context,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  eventName: string,
  orgId: string,
  uniqId: string,
): Promise<boolean | null> {
  const notif = await getNotification(c, drizzleClient, orgId, eventName, uniqId)
  if (notif === undefined)
    return null
  return notif !== null
}

async function insertNotificationClaim(
  writeClient: ReturnType<typeof getDrizzleClient>,
  eventName: string,
  orgId: string,
  uniqId: string,
  claimedAt: Date = new Date(),
): Promise<boolean> {
  const inserted = await writeClient
    .insert(schema.notifications)
    .values({
      event: eventName,
      uniq_id: uniqId,
      owner_org: orgId,
      last_send_at: claimedAt,
      total_send: 1,
    })
    .onConflictDoNothing({
      target: [schema.notifications.owner_org, schema.notifications.event, schema.notifications.uniq_id],
    })
    .returning()

  return inserted.length > 0
}

async function deleteNotificationClaim(
  writeClient: ReturnType<typeof getDrizzleClient>,
  eventName: string,
  orgId: string,
  uniqId: string,
) {
  await writeClient
    .delete(schema.notifications)
    .where(and(
      eq(schema.notifications.event, eventName),
      eq(schema.notifications.uniq_id, uniqId),
      eq(schema.notifications.owner_org, orgId),
    ))
}

type NotificationClaimRollback
  = | { claimedAt: Date, kind: 'insert' }
    | { claimedAt: Date, kind: 'update', previousLastSendAt: Date, previousTotalSend: number }

async function rollbackNotificationClaim(
  c: Context,
  writeClient: ReturnType<typeof getDrizzleClient>,
  eventName: string,
  orgId: string,
  uniqId: string,
  claim: NotificationClaimRollback,
) {
  try {
    if (claim.kind === 'insert') {
      await writeClient
        .delete(schema.notifications)
        .where(and(
          eq(schema.notifications.event, eventName),
          eq(schema.notifications.uniq_id, uniqId),
          eq(schema.notifications.owner_org, orgId),
          eq(schema.notifications.last_send_at, claim.claimedAt),
        ))
      return true
    }

    await writeClient
      .update(schema.notifications)
      .set({
        last_send_at: claim.previousLastSendAt,
        total_send: claim.previousTotalSend,
      })
      .where(and(
        eq(schema.notifications.event, eventName),
        eq(schema.notifications.uniq_id, uniqId),
        eq(schema.notifications.owner_org, orgId),
        eq(schema.notifications.last_send_at, claim.claimedAt),
      ))
    return true
  }
  catch (e: unknown) {
    logPgError(c, 'rollbackNotificationClaim', e)
    return false
  }
}

export async function sendNotifOrg(
  c: Context,
  eventName: string,
  eventData: EventData,
  orgId: string,
  uniqId: string,
  cron: string,
  managementEmail: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<boolean | { sent: false, lastSendAt: string }> {
  if (shouldSkipSupabaseNotificationWrites(c)) {
    logSkippedSupabaseWrite(c, 'sendNotifOrg')
    return false
  }

  // Check if notification has already been sent (read from replica)
  const notif = await getNotification(c, drizzleClient, orgId, eventName, uniqId)
  if (notif === undefined) {
    cloudlog({ requestId: c.get('requestId'), message: 'notif lookup failed', event: eventName, orgId, uniqId })
    return false
  }

  // Create write-capable drizzle client for mutations
  const pgClient = getPgClient(c)
  const writeClient = createDrizzleClient(pgClient)

  let shouldSend = false
  let isFirstSend = false
  let claimRollback: NotificationClaimRollback | undefined

  try {
    if (!notif) {
      // First time: use insert with onConflictDoNothing to avoid error logs
      isFirstSend = true

      // Only send if we successfully inserted (won the race)
      const claimedAt = new Date()
      shouldSend = await insertNotificationClaim(writeClient, eventName, orgId, uniqId, claimedAt)
      if (!shouldSend) {
        cloudlog({ requestId: c.get('requestId'), message: 'notif insert race lost', event: eventName, orgId })
        return false
      }
      claimRollback = { kind: 'insert', claimedAt }
    }
    else {
      // Notification exists, check if sendable
      const lastSendAtStr = notif.last_send_at.toISOString()
      if (!isSendable(c, lastSendAtStr, cron)) {
        cloudlog({ requestId: c.get('requestId'), message: 'notif already sent', event: eventName, orgId })
        return { sent: false, lastSendAt: lastSendAtStr }
      }

      // Atomically update ONLY if timestamp hasn't changed (optimistic locking to prevent race)
      const claimedAt = new Date()
      const updated = await writeClient
        .update(schema.notifications)
        .set({
          last_send_at: claimedAt,
          total_send: notif.total_send + 1,
        })
        .where(and(
          eq(schema.notifications.event, eventName),
          eq(schema.notifications.uniq_id, uniqId),
          eq(schema.notifications.owner_org, orgId),
          eq(schema.notifications.last_send_at, notif.last_send_at), // Optimistic lock: only update if timestamp unchanged
        ))
        .returning()

      // Only send if we successfully claimed it (update succeeded)
      shouldSend = updated.length > 0
      if (!shouldSend) {
        cloudlog({ requestId: c.get('requestId'), message: 'notif update race lost', event: eventName, orgId })
        return false
      }
      claimRollback = { kind: 'update', claimedAt, previousLastSendAt: notif.last_send_at, previousTotalSend: notif.total_send }
    }

    // Only send if we successfully claimed the notification
    if (shouldSend) {
      cloudlog({ requestId: c.get('requestId'), message: isFirstSend ? 'notif never sent' : 'notif ready to sent', event: eventName, uniqId })
      const res = await trackBentoEvent(c, managementEmail, eventData, eventName)
      if (!res) {
        const rollbackSucceeded = await rollbackNotificationClaim(c, writeClient, eventName, orgId, uniqId, claimRollback!)
        cloudlog({ requestId: c.get('requestId'), message: 'trackEvent failed', eventName, email: managementEmail, eventData, rollbackSucceeded })
        return false
      }

      cloudlog({ requestId: c.get('requestId'), message: 'send notif done', eventName, email: managementEmail })
      return true
    }

    return false
  }
  catch (e: unknown) {
    if (claimRollback)
      await rollbackNotificationClaim(c, writeClient, eventName, orgId, uniqId, claimRollback)
    logPgError(c, 'sendNotifOrg', e)
    return false
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export async function claimNotifOrgOnce(
  c: Context,
  eventName: string,
  orgId: string,
  uniqId: string,
  writeClient?: ReturnType<typeof createDrizzleClient>,
): Promise<boolean> {
  if (shouldSkipSupabaseNotificationWrites(c)) {
    logSkippedSupabaseWrite(c, 'claimNotifOrgOnce')
    return false
  }

  const ownedPgClient = writeClient ? undefined : getPgClient(c)
  const effectiveWriteClient = writeClient ?? createDrizzleClient(ownedPgClient!)

  try {
    const claimed = await insertNotificationClaim(effectiveWriteClient, eventName, orgId, uniqId)
    if (!claimed) {
      cloudlog({ requestId: c.get('requestId'), message: 'notif once already claimed', event: eventName, orgId, uniqId })
    }
    return claimed
  }
  catch (e: unknown) {
    logPgError(c, 'claimNotifOrgOnce', e)
    return false
  }
  finally {
    if (ownedPgClient)
      await closeClient(c, ownedPgClient)
  }
}

export async function sendNotifOrgOnce(
  c: Context,
  eventName: string,
  eventData: EventData,
  orgId: string,
  uniqId: string,
  recipientEmail: string,
  _drizzleClient: ReturnType<typeof getDrizzleClient>,
  writeClient?: ReturnType<typeof createDrizzleClient>,
): Promise<SendNotifOrgOnceResult> {
  if (shouldSkipSupabaseNotificationWrites(c)) {
    logSkippedSupabaseWrite(c, 'sendNotifOrgOnce')
    return { sent: false, cleanupFailed: false }
  }

  const ownedPgClient = writeClient ? undefined : getPgClient(c)
  const effectiveWriteClient = writeClient ?? createDrizzleClient(ownedPgClient!)

  try {
    const claimed = await claimNotifOrgOnce(c, eventName, orgId, uniqId, effectiveWriteClient)
    if (!claimed)
      return { sent: false, cleanupFailed: false }

    const cleanupClaim = async (): Promise<boolean> => {
      try {
        await deleteNotificationClaim(effectiveWriteClient, eventName, orgId, uniqId)
        return true
      }
      catch (cleanupError) {
        logPgError(c, 'sendNotifOrgOnce cleanup', cleanupError)
        return false
      }
    }

    try {
      const res = await trackBentoEvent(c, recipientEmail, eventData, eventName)
      if (!res) {
        const cleanupSucceeded = await cleanupClaim()
        cloudlog({ requestId: c.get('requestId'), message: 'trackEvent failed for one-time notif', eventName, email: recipientEmail, eventData })
        return { sent: false, cleanupFailed: !cleanupSucceeded }
      }

      cloudlog({ requestId: c.get('requestId'), message: 'send one-time notif done', eventName, email: recipientEmail, uniqId })
      return { sent: true, cleanupFailed: false }
    }
    catch (e: unknown) {
      const cleanupSucceeded = await cleanupClaim()
      logPgError(c, 'sendNotifOrgOnce', e)
      return { sent: false, cleanupFailed: !cleanupSucceeded }
    }
  }
  finally {
    if (ownedPgClient)
      await closeClient(c, ownedPgClient)
  }
}

// dayjs subtract one week
// const last_send_at = dayjs().subtract(1, 'week').toISOString()
// cloudlog(c.get('requestId'), 'isSendable', isSendable(last_send_at, '0 0 1 * *'))

/**
 * Cached version of sendNotifOrg that checks cache before querying the database.
 * If a notification was recently checked and found to be "not sendable", the cached
 * result is returned immediately without hitting the database.
 *
 * The cache TTL is calculated based on the cron schedule and last send time,
 * so the cache expires exactly when the notification becomes sendable again.
 */
export async function sendNotifOrgCached(
  c: Context,
  eventName: string,
  eventData: EventData,
  orgId: string,
  uniqId: string,
  cron: string,
  managementEmail: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<boolean> {
  if (shouldQueuePluginNotifications(c)) {
    const { queuePluginOrgNotification } = await import('./plugin_notification_queue.ts')
    await queuePluginOrgNotification(c, eventName, eventData, orgId, uniqId, cron, managementEmail)
    return false
  }

  // Check cache first - if we recently checked and it wasn't sendable, skip DB query
  const cachedSendable = await getNotifCacheStatus(c, orgId, eventName, uniqId)
  if (cachedSendable === false) {
    cloudlog({ requestId: c.get('requestId'), message: 'notif cache hit - not sendable', event: eventName, orgId, uniqId })
    return false
  }

  // Cache miss, call the actual function
  const result = await sendNotifOrg(c, eventName, eventData, orgId, uniqId, cron, managementEmail, drizzleClient)

  // Handle the "not sendable" case with lastSendAt for proper TTL calculation
  if (typeof result === 'object' && result.sent === false && result.lastSendAt) {
    const ttlSeconds = getSecondsUntilNextCronWindow(result.lastSendAt, cron)
    cloudlog({ requestId: c.get('requestId'), message: 'notif caching not sendable', event: eventName, orgId, ttlSeconds })
    setNotifCacheStatus(c, orgId, eventName, uniqId, false, ttlSeconds)
    return false
  }

  // For other cases (true/false), just return the boolean result
  // No need to cache "sent=true" as next check should query DB anyway
  return result === true
}
