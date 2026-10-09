import type { MessageBatch, Queue } from '@cloudflare/workers-types'
import type { PostHogDeliveryResult } from './posthog_delivery.ts'
import { z } from 'zod'
import { cloudlog } from './logging.ts'
import { deliverPosthogCapture } from './posthog_delivery.ts'

// Leave headroom for serialization overhead and explicit DLQ failure metadata.
export const POSTHOG_MESSAGE_MAX_BYTES = 96 * 1024
export const POSTHOG_RETRY_DELAYS = [30, 120, 600, 1800, 7200] as const
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const isoTime = z.string().datetime()
const forbiddenKeys = new Set(['capgkey', 'capgokey', 'apisecret', 'auth', 'authentication', 'bearer', 'posthogtoken', 'supabasekey', 'servicerolekey', 'sessiontoken', 'authorization', 'authheaders', 'headers', 'cookie', 'jwt', 'apikey', 'posthogapikey', 'capgotoken', 'token', 'accesstoken', 'refreshtoken', 'secret', 'password', 'bento', 'rawbody', '$groups', '$insertid', '$set', '$setonce', 'distinctid', 'eventid'])
function forbiddenKey(key: string) {
  return forbiddenKeys.has(key.toLowerCase().replace(/[_\s-]/g, ''))
}

function validJson(value: unknown, depth = 0): boolean {
  if (depth > 8)
    return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value)
  if (Array.isArray(value))
    return value.every(item => validJson(item, depth + 1))
  return typeof value === 'object' && value !== null && Object.entries(value).every(([key, item]) => !forbiddenKey(key) && validJson(item, depth + 1))
}

const properties = z.record(z.string(), z.unknown()).refine(validJson)
export const posthogMessageSchema = z.object({
  version: z.literal(1),
  source: z.literal('private_events'),
  event_id: z.string().regex(UUID),
  accepted_at: isoTime,
  request_id: z.string().min(1).max(128),
  payload: z.object({
    event: z.string().min(1),
    channel: z.string().min(1),
    description: z.string().optional(),
    distinct_id: z.string().min(1),
    tags: properties.optional(),
    nonPersonTags: properties.optional(),
    groups: z.object({ organization: z.string().min(1) }).strict().optional(),
    ip: z.string().optional(),
    timestamp: isoTime,
    setPersonProperties: z.boolean().optional(),
  }).strict(),
}).strict()
export type PostHogQueueMessage = Readonly<z.infer<typeof posthogMessageSchema>>
export interface PostHogQueueEnv {
  POSTHOG_QUEUE?: Pick<Queue, 'send'>
  POSTHOG_DLQ?: Pick<Queue, 'send'>
  POSTHOG_API_KEY?: string
  POSTHOG_API_HOST?: string
}

export class PostHogQueueError extends Error {
  constructor(readonly code: 'oversized' | 'invalid_payload' | 'unavailable') {
    super(code)
  }
}

export function messageBytes(body: unknown) {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

export function parsePostHogMessage(body: unknown): PostHogQueueMessage | undefined {
  try {
    if (messageBytes(body) > POSTHOG_MESSAGE_MAX_BYTES)
      return undefined
    const parsed = posthogMessageSchema.safeParse(body)
    return parsed.success ? parsed.data : undefined
  }
  catch {
    return undefined
  }
}

// Copy only analytics properties and strip credential/reserved keys at every depth.
export function snapshotProperties(value: unknown, depth = 0): unknown {
  if (depth > 8)
    throw new PostHogQueueError('invalid_payload')
  if (Array.isArray(value))
    return value.map(item => snapshotProperties(item, depth + 1))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKey(key)).map(([key, item]) => [key, snapshotProperties(item, depth + 1)]))
  return value
}

export async function enqueuePostHog(queue: PostHogQueueEnv['POSTHOG_QUEUE'], body: unknown) {
  if (messageBytes(body) > POSTHOG_MESSAGE_MAX_BYTES)
    throw new PostHogQueueError('oversized')
  const message = parsePostHogMessage(body)
  if (!message)
    throw new PostHogQueueError('invalid_payload')
  if (!queue?.send)
    throw new PostHogQueueError('unavailable')
  try {
    // Queue JSON serialization is the immutable snapshot; no shared request object survives it.
    await queue.send(message, { contentType: 'json' })
  }
  catch {
    throw new PostHogQueueError('unavailable')
  }
}

export interface PostHogDlqEnvelope {
  version: 1
  source: 'posthog_dlq'
  original: unknown
  failure: {
    outcome: PostHogDeliveryResult['outcome'] | 'invalid_body'
    reason?: string
    http_status?: number | null
    failed_at: string
    attempts: number
  }
}

export function replayablePostHogMessage(body: unknown) {
  const original = body && typeof body === 'object' && 'source' in body && body.source === 'posthog_dlq'
    && 'version' in body && body.version === 1 && 'original' in body
    ? body.original
    : body
  return parsePostHogMessage(original)
}

export async function processPostHogQueueBatch(batch: MessageBatch<unknown>, env: PostHogQueueEnv) {
  // Ten concurrent captures per invocation, each bounded to 5s fetch + 1s response inspection.
  // With max_concurrency=2, at most twenty provider requests are in flight.
  await Promise.all(batch.messages.map(async (entry) => {
    const startedAt = Date.now()
    let message: PostHogQueueMessage | undefined
    const log = (outcome: string, extra: Record<string, string | number | null> = {}) => cloudlog({
      message: 'posthog_queue_delivery',
      event_id: message?.event_id,
      requestId: message?.request_id,
      outcome,
      attempts: entry.attempts,
      age_ms: message ? Math.max(0, startedAt - Date.parse(message.accepted_at)) : null,
      duration_ms: Date.now() - startedAt,
      ...extra,
    })
    const retry = (outcome: string, extra: Record<string, string | number | null> = {}) => {
      entry.retry({ delaySeconds: POSTHOG_RETRY_DELAYS[Math.min(Math.max(entry.attempts - 1, 0), 4)] })
      log(outcome, extra)
    }
    try {
      message = parsePostHogMessage(entry.body)
      const delivery = message
        ? await deliverPosthogCapture({ apiKey: env.POSTHOG_API_KEY, host: env.POSTHOG_API_HOST }, {
            ...message.payload,
            event_id: message.event_id,
            timeoutMs: 5000,
          })
        : undefined
      if (delivery?.outcome === 'delivered') {
        entry.ack()
        log('delivered', { http_status: delivery.http_status })
        return
      }
      if (delivery?.outcome === 'retryable' || delivery?.outcome === 'ambiguous') {
        retry(delivery.outcome, { http_status: delivery.http_status, ...('reason' in delivery ? { reason: delivery.reason } : {}) })
        return
      }
      const envelope: PostHogDlqEnvelope = {
        version: 1,
        source: 'posthog_dlq',
        original: entry.body,
        failure: {
          outcome: delivery?.outcome ?? 'invalid_body',
          ...((delivery && 'reason' in delivery) ? { reason: delivery.reason } : {}),
          http_status: delivery?.http_status,
          failed_at: new Date().toISOString(),
          attempts: entry.attempts,
        },
      }
      if (!env.POSTHOG_DLQ?.send)
        throw new Error('DLQ unavailable')
      // Invalid oversized originals may need all available headroom. Preserve them raw.
      await env.POSTHOG_DLQ.send(messageBytes(envelope) < 124 * 1024 ? envelope : entry.body, { contentType: 'json' })
      entry.ack()
      log('dead_lettered', { delivery_outcome: delivery?.outcome ?? 'invalid_body', http_status: delivery?.http_status ?? null })
    }
    catch {
      // Includes unexpected exceptions and failed DLQ persistence. Never ack on loss.
      retry('consumer_retry')
    }
  }))
}
