import type { TrackOptions } from '@logsnag/node'
import type { Context } from 'hono'
import type { EmailPreferenceKey, NotificationAudience } from './org_email_notifications.ts'
import type { PostHogGroups } from './posthog.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { logsnag } from './logsnag.ts'
import { sendNotifToOrgMembers, sendNotifToOrgMembersOnce } from './org_email_notifications.ts'
import { getDrizzleClient, getPgClient } from './pg.ts'
import { trackPosthogEvent } from './posthog.ts'
import { backgroundTask } from './utils.ts'

export interface BentoTrackingPayload {
  /** Cron window for the throttle/dedupe. Used only when `once` is not set. */
  cron?: string
  data: Record<string, unknown>
  event: string
  /**
   * Send at most ONE notification ever per (event, org, uniqId) via a permanent
   * claim instead of a reopening cron window. Use for per-entity alerts that must
   * not re-fire on retries (e.g. an incompatible bundle version). Ignores `cron`.
   */
  once?: boolean
  preferenceKey: EmailPreferenceKey
  uniqId: string
  /** Which org members receive the email. Defaults to 'admins'; use 'billing' for payment/subscription events. */
  audience?: NotificationAudience
}

export interface SendEventToTrackingPayload extends TrackOptions {
  bento?: BentoTrackingPayload
  groups?: PostHogGroups
  sentToBento?: boolean
  nonPersonTags?: Record<string, string | number | boolean>
}

export interface SendEventToTrackingOptions {
  background?: boolean
  ip?: string
  posthog?: boolean
  strict?: boolean
}

export function addAuthenticatedApiKeyIdToTrackingPayload(
  payload: SendEventToTrackingPayload,
  apikeyId: number | undefined,
): SendEventToTrackingPayload {
  const hasCallerProvidedTagApiKeyId = payload.tags && Object.hasOwn(payload.tags, 'apikey_id')
  const hasCallerProvidedNonPersonApiKeyId = payload.nonPersonTags && Object.hasOwn(payload.nonPersonTags, 'apikey_id')
  const { apikey_id: _callerProvidedApiKeyId, ...tags } = payload.tags ?? {}
  const { apikey_id: _callerProvidedNonPersonApiKeyId, ...nonPersonTags } = payload.nonPersonTags ?? {}
  const payloadWithoutCallerApiKeyId = hasCallerProvidedTagApiKeyId || hasCallerProvidedNonPersonApiKeyId
    ? {
        ...payload,
        ...(hasCallerProvidedTagApiKeyId ? { tags } : {}),
        ...(hasCallerProvidedNonPersonApiKeyId ? { nonPersonTags } : {}),
      }
    : payload

  if (apikeyId === undefined)
    return payloadWithoutCallerApiKeyId

  return {
    ...payloadWithoutCallerApiKeyId,
    nonPersonTags: { ...nonPersonTags, apikey_id: apikeyId },
  }
}

async function runTrackedCall(c: Context, provider: string, task: () => Promise<unknown>, strict = false) {
  try {
    const result = await task()
    if (strict && result === false)
      throw new Error(`${provider} tracking returned false`)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'sendEventToTracking provider failed',
      provider,
      error: serializeError(error),
    })
    if (strict)
      throw error
  }
}

function getTrackingIp(c: Context, ip?: string) {
  if (ip)
    return ip

  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
}

function getTrackingTimestamp(timestamp: TrackOptions['timestamp']) {
  if (timestamp === undefined)
    return undefined

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

async function executeTracking(c: Context, payload: SendEventToTrackingPayload, options: SendEventToTrackingOptions) {
  const tasks: Array<Promise<void>> = [
    runTrackedCall(c, 'logsnag', () => logsnag(c).track(payload), options.strict),
  ]
  if (options.posthog !== false) {
    tasks.push(runTrackedCall(c, 'posthog', () => trackPosthogEvent(c, {
      event: payload.event,
      user_id: payload.user_id,
      tags: payload.tags,
      nonPersonTags: payload.nonPersonTags,
      channel: payload.channel,
      description: payload.description,
      groups: payload.groups,
      ip: getTrackingIp(c, options.ip),
      timestamp: getTrackingTimestamp(payload.timestamp),
    }), options.strict))
  }

  await Promise.all(tasks)
}

async function executeBentoTracking(c: Context, payload: SendEventToTrackingPayload, strict = false) {
  if (!payload.sentToBento)
    return

  const bento = payload.bento
  if (!bento) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'sendEventToTracking missing Bento payload',
      event: payload.event,
      user_id: payload.user_id,
    })
    if (strict)
      throw new Error('sendEventToTracking missing Bento payload')
    return
  }

  // Under tracking v2 the org lives in the PostHog `organization` group, not in
  // user_id (which is now the authenticated actor). Fall back to user_id for
  // legacy v1 payloads where user_id still carried the org id.
  const orgId = payload.groups?.organization ?? payload.user_id
  if (!orgId || typeof orgId !== 'string') {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'sendEventToTracking missing org id for Bento notification',
      event: payload.event,
      user_id: payload.user_id,
    })
    if (strict)
      throw new Error('sendEventToTracking missing org id for Bento notification')
    return
  }

  await runTrackedCall(c, 'bento', async () => {
    const pgClient = getPgClient(c, true)
    try {
      if (bento.once) {
        // Permanent per-(event, org, uniqId) claim: per-entity alerts (e.g. an
        // incompatible bundle version) must not re-email org admins on retries.
        // Discard the boolean: false is often benign (already claimed, no
        // recipients, Bento unset). Under strict, only thrown errors fail closed.
        await sendNotifToOrgMembersOnce(
          c,
          bento.event,
          bento.preferenceKey,
          bento.data,
          orgId,
          bento.uniqId,
          getDrizzleClient(pgClient),
          bento.audience,
        )
        return
      }
      await sendNotifToOrgMembers(
        c,
        bento.event,
        bento.preferenceKey,
        bento.data,
        orgId,
        bento.uniqId,
        bento.cron ?? '* * * * *',
        getDrizzleClient(pgClient),
        bento.audience,
      )
    }
    finally {
      await pgClient.end()
    }
  }, strict)
}

export async function sendEventToTracking(c: Context, payload: SendEventToTrackingPayload, options: SendEventToTrackingOptions = {}) {
  const trackingTask = executeTracking(c, payload, options)
  if (options.background === false) {
    await trackingTask
    await executeBentoTracking(c, payload, options.strict === true)
    return
  }

  await backgroundTask(c, trackingTask)
  await backgroundTask(c, executeBentoTracking(c, payload, options.strict === true))
}
