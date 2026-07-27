import type { Context } from 'hono'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { getPublicHostnameValidationError, getPublicUrlSyntaxValidationError } from './publicUrl.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

// Webhook payload structure sent to user endpoints
export interface WebhookPayload {
  type: string // Standard Webhooks event type
  event: string // e.g., 'app_versions.INSERT'
  event_id: string // Unique event identifier
  timestamp: string // ISO timestamp
  org_id: string // Organization ID
  data: {
    table: string
    operation: string
    record_id: string
    old_record: Record<string, unknown> | null
    new_record: Record<string, unknown> | null
    changed_fields: string[] | null
    actor_type?: 'user' | 'apikey' | 'system' | 'unknown'
    actor_user_id?: string | null
    actor_user_email?: string | null
    actor_apikey_id?: number | null
    actor_apikey_name?: string | null
  }
}

export type LegacyWebhookPayload = Omit<WebhookPayload, 'type'>
export type WebhookDeliveryPayload = WebhookPayload | LegacyWebhookPayload

export const WEBHOOK_DELIVERY_VERSIONS = ['legacy', 'standard'] as const
export type WebhookDeliveryVersion = typeof WEBHOOK_DELIVERY_VERSIONS[number]

export function parseWebhookDeliveryVersion(value: unknown): WebhookDeliveryVersion | null {
  return value === 'legacy' || value === 'standard' ? value : null
}

export function normalizeWebhookDeliveryVersion(value: unknown): WebhookDeliveryVersion {
  return parseWebhookDeliveryVersion(value) ?? 'legacy'
}

export function buildWebhookDeliveryPayload(
  payload: WebhookDeliveryPayload,
  deliveryVersion: WebhookDeliveryVersion,
): WebhookDeliveryPayload {
  if (deliveryVersion === 'standard') {
    return {
      ...payload,
      type: 'type' in payload ? payload.type : payload.event,
    }
  }

  const { type: _type, ...legacyPayload } = payload as WebhookPayload
  return legacyPayload
}

export function getWebhookPayloadEvent(payload: WebhookDeliveryPayload): string {
  return payload.event
}

export function getWebhookPayloadEventId(payload: WebhookDeliveryPayload): string {
  return payload.event_id
}

// Audit log data from the database trigger
export interface AuditLogData {
  audit_log_id: number
  table_name: string
  operation: string
  org_id: string
  record_id: string
  old_record: Record<string, unknown> | null
  new_record: Record<string, unknown> | null
  changed_fields: string[] | null
  user_id: string | null
  actor_type?: 'user' | 'apikey' | 'system' | 'unknown'
  actor_user_id?: string | null
  actor_user_email?: string | null
  actor_apikey_id?: number | null
  actor_apikey_name?: string | null
  created_at: string
}

// Supported event types that users can subscribe to
export const WEBHOOK_EVENT_TYPES = [
  'apps', // App changes (INSERT, UPDATE, DELETE)
  'app_versions', // Bundle changes (INSERT, UPDATE, DELETE)
  'channels', // Channel updates
  'org_users', // Member changes
  'orgs', // Organization changes
] as const

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number]

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
}

const WEBHOOK_DELIVERY_TIMEOUT_MS = 20000
const WEBHOOK_RESPONSE_BODY_LIMIT_BYTES = 10000
const WEBHOOK_MAX_RETRY_AFTER_SECONDS = 2 * 60 * 60
// HARD RULE: same ceiling as MAX_QUEUE_READS — never more than 5 delivery attempts.
export const WEBHOOK_MAX_ATTEMPTS = 5
const WEBHOOK_RETRY_THROTTLE_STATUSES = new Set([429, 502, 504])
// Delays for retries after attempts 1..4 (5th attempt is terminal). Every value
// must stay <= WEBHOOK_MAX_RETRY_AFTER_SECONDS.
const WEBHOOK_RETRY_DELAYS_SECONDS = [
  5,
  5 * 60,
  30 * 60,
  2 * 60 * 60,
]

interface WebhookLogUrlMetadata {
  valid: boolean
  protocol?: string
  hostnameLength?: number
  pathSegmentCount?: number
  hasQuery?: boolean
  hasCredentials?: boolean
}

export function getWebhookLogUrlMetadata(urlString: string): WebhookLogUrlMetadata {
  try {
    const parsedUrl = new URL(urlString)
    return {
      valid: true,
      protocol: parsedUrl.protocol.replace(/:$/, ''),
      hostnameLength: parsedUrl.hostname.length,
      pathSegmentCount: parsedUrl.pathname.split('/').filter(Boolean).length,
      hasQuery: parsedUrl.search.length > 0,
      hasCredentials: Boolean(parsedUrl.username || parsedUrl.password),
    }
  }
  catch {
    return { valid: false }
  }
}

function allowLocalWebhookUrls(c: Context): boolean {
  return getEnv(c, 'CAPGO_ALLOW_LOCAL_WEBHOOK_URLS') === 'true'
}

const WEBHOOK_URL_VALIDATION_MESSAGES = {
  invalidUrl: 'Webhook URL is invalid',
  publicHost: 'Webhook URL must point to a public host',
  ipLiteral: 'Webhook URL must use a hostname, not an IP address',
  https: 'Webhook URL must use HTTPS',
  dnsResolution: 'Webhook URL host could not be resolved',
}

export function getWebhookUrlValidationError(c: Context, urlString: string): string | null {
  return getPublicUrlSyntaxValidationError(urlString, {
    allowLocalUrls: allowLocalWebhookUrls(c),
    messages: WEBHOOK_URL_VALIDATION_MESSAGES,
  })
}

export async function getWebhookPublicUrlValidationError(c: Context, urlString: string): Promise<string | null> {
  return await getPublicHostnameValidationError(urlString, {
    allowLocalUrls: allowLocalWebhookUrls(c),
    // Do not fail customer webhooks when DNS preflight is unavailable; block only explicit private answers.
    requireDnsResolution: false,
    messages: WEBHOOK_URL_VALIDATION_MESSAGES,
  })
}

/**
 * Build a webhook payload from audit log data
 */
export function buildWebhookPayload(auditLogData: AuditLogData): WebhookPayload {
  const eventType = `${auditLogData.table_name}.${auditLogData.operation}`
  return {
    type: eventType,
    event: eventType,
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    org_id: auditLogData.org_id,
    data: {
      table: auditLogData.table_name,
      operation: auditLogData.operation,
      record_id: auditLogData.record_id,
      old_record: auditLogData.old_record,
      new_record: auditLogData.new_record,
      changed_fields: auditLogData.changed_fields,
      actor_type: auditLogData.actor_type ?? (auditLogData.user_id ? 'user' : 'unknown'),
      actor_user_id: auditLogData.actor_user_id ?? auditLogData.user_id,
      actor_user_email: auditLogData.actor_user_email ?? null,
      actor_apikey_id: auditLogData.actor_apikey_id ?? null,
      actor_apikey_name: auditLogData.actor_apikey_name ?? null,
    },
  }
}

/**
 * Find all enabled webhooks for an organization that subscribe to a specific event
 */
export async function findWebhooksForEvent(
  c: Context,
  orgId: string,
  tableName: string,
) {
  // Note: Using type assertion as webhooks table types are not yet generated
  const { data: webhooks, error } = await supabaseAdmin(c)
    .from('webhooks')
    .select('*')
    .eq('org_id', orgId)
    .eq('enabled', true)
    .contains('events', [tableName])

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error finding webhooks', error: serializeError(error) })
    return []
  }

  return webhooks || []
}

/**
 * Create a webhook delivery record
 */
export async function createDeliveryRecord(
  c: Context,
  webhookId: string,
  orgId: string,
  auditLogId: number | null,
  eventType: string,
  payload: WebhookDeliveryPayload,
  deliveryVersion: WebhookDeliveryVersion = 'legacy',
) {
  const requestPayload = buildWebhookDeliveryPayload(payload, deliveryVersion)

  // Note: Using type assertion as webhook_deliveries table types are not yet generated
  const { data: delivery, error } = await supabaseAdmin(c)
    .from('webhook_deliveries')
    .insert({
      webhook_id: webhookId,
      org_id: orgId,
      audit_log_id: auditLogId,
      event_type: eventType,
      request_payload: requestPayload as any,
      delivery_version: deliveryVersion,
      status: 'pending',
    })
    .select()
    .single()

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error creating delivery record', error: serializeError(error) })
    return null
  }

  return delivery
}

/**
 * Generate the legacy Capgo HMAC-SHA256 signature for webhook payload
 * The signature format is: v1={timestamp}.{hmac}
 * This allows receivers to verify the request came from Capgo
 */
export async function generateWebhookSignature(
  secret: string,
  timestamp: string,
  payload: string,
): Promise<string> {
  const signaturePayload = `${timestamp}.${payload}`

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signaturePayload),
  )

  const hexSignature = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return `v1=${timestamp}.${hexSignature}`
}

function base64Encode(bytes: ArrayBuffer): string {
  const byteArray = new Uint8Array(bytes)
  const binary = Array.from(byteArray, byte => String.fromCodePoint(byte)).join('')
  return btoa(binary)
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function decodeSerializedWebhookSecret(secret: string): ArrayBuffer {
  const encoder = new TextEncoder()
  if (!secret.startsWith('whsec_'))
    return bytesToArrayBuffer(encoder.encode(secret))

  try {
    const decoded = atob(secret.slice('whsec_'.length))
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i++)
      bytes[i] = decoded.codePointAt(i) ?? 0

    // Standard Webhooks symmetric keys are 24-64 random bytes. Existing Capgo
    // whsec hex strings decode to 24 bytes, so they can verify through standard
    // libraries without rotating customer secrets.
    if (bytes.length >= 24 && bytes.length <= 64)
      return bytesToArrayBuffer(bytes)
  }
  catch {
    // Fall through to legacy raw-text signing for malformed historical secrets.
  }

  return bytesToArrayBuffer(encoder.encode(secret))
}

/**
 * Generate a Standard Webhooks HMAC-SHA256 signature.
 * The signed content is webhook-id.webhook-timestamp.payload.
 */
export async function generateStandardWebhookSignature(
  secret: string,
  messageId: string,
  timestamp: string,
  payload: string,
): Promise<string> {
  const signaturePayload = `${messageId}.${timestamp}.${payload}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSerializedWebhookSecret(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signaturePayload),
  )

  return `v1,${base64Encode(signature)}`
}

export function parseRetryAfterSeconds(retryAfter: string | null | undefined, now = new Date()): number | null {
  if (!retryAfter)
    return null

  const trimmed = retryAfter.trim()
  if (!trimmed)
    return null

  if (/^\d+$/.test(trimmed))
    return Math.min(Number.parseInt(trimmed, 10), WEBHOOK_MAX_RETRY_AFTER_SECONDS)

  const retryDate = new Date(trimmed)
  const retryAt = retryDate.getTime()
  if (Number.isNaN(retryAt))
    return null

  const seconds = Math.ceil((retryAt - now.getTime()) / 1000)
  if (seconds <= 0)
    return null

  return Math.min(seconds, WEBHOOK_MAX_RETRY_AFTER_SECONDS)
}

function getWebhookRetryRandomValue(): number {
  const randomBytes = new Uint32Array(1)
  crypto.getRandomValues(randomBytes)
  return randomBytes[0] / 0x100000000
}

export function getWebhookRetryDelaySeconds(
  attemptCount: number,
  retryAfter: string | null | undefined,
  status: number | null | undefined,
  randomValue = getWebhookRetryRandomValue(),
): number {
  const retryIndex = Math.max(0, Math.min(attemptCount - 1, WEBHOOK_RETRY_DELAYS_SECONDS.length - 1))
  let delaySeconds = WEBHOOK_RETRY_DELAYS_SECONDS[retryIndex]

  if (status && WEBHOOK_RETRY_THROTTLE_STATUSES.has(status))
    delaySeconds = Math.max(delaySeconds, 5 * 60)

  const retryAfterSeconds = parseRetryAfterSeconds(retryAfter)
  if (retryAfterSeconds !== null)
    delaySeconds = Math.max(delaySeconds, retryAfterSeconds)

  const minimumDelaySeconds = delaySeconds
  const jitterRange = Math.max(1, Math.ceil(delaySeconds * 0.1))
  const jitter = Math.floor(randomValue * (jitterRange * 2 + 1)) - jitterRange

  return Math.max(
    minimumDelaySeconds,
    Math.min(WEBHOOK_MAX_RETRY_AFTER_SECONDS, delaySeconds + jitter),
  )
}

async function readWebhookResponsePreview(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader)
    return ''

  const decoder = new TextDecoder()
  let preview = ''
  let receivedBytes = 0
  let shouldCancel = true

  try {
    while (receivedBytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) {
        shouldCancel = false
        break
      }

      if (!value)
        continue

      const remainingBytes = maxBytes - receivedBytes
      const chunk = value.byteLength > remainingBytes
        ? value.subarray(0, remainingBytes)
        : value

      receivedBytes += chunk.byteLength
      preview += decoder.decode(chunk, { stream: true })

      if (chunk.byteLength < value.byteLength)
        break
    }

    preview += decoder.decode()
    return preview
  }
  finally {
    if (shouldCancel)
      await reader.cancel().catch(() => undefined)
  }
}

/**
 * Deliver a webhook to the user's endpoint
 */
export async function deliverWebhook(
  c: Context,
  deliveryId: string,
  url: string,
  payload: WebhookDeliveryPayload,
  secret: string,
  deliveryVersion: WebhookDeliveryVersion = 'legacy',
): Promise<{ success: boolean, status?: number, body?: string, duration?: number, retryAfter?: string | null }> {
  const startTime = Date.now()
  const urlInfo = getWebhookLogUrlMetadata(url)

  const urlValidationError = await getWebhookPublicUrlValidationError(c, url)
  if (urlValidationError) {
    const duration = Date.now() - startTime
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Webhook delivery blocked by URL validation',
      deliveryId,
      urlInfo,
      error: urlValidationError,
      duration,
    })

    return {
      success: false,
      body: `Error: ${urlValidationError}`,
      duration,
    }
  }

  const deliveryPayload = buildWebhookDeliveryPayload(payload, deliveryVersion)
  const payloadString = JSON.stringify(deliveryPayload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const eventId = getWebhookPayloadEventId(deliveryPayload)
  const event = getWebhookPayloadEvent(deliveryPayload)

  const legacySignature = await generateWebhookSignature(secret, timestamp, payloadString)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Capgo-Webhook/1.0',
    'X-Capgo-Event': event,
    'X-Capgo-Event-ID': eventId,
    'X-Capgo-Timestamp': timestamp,
    'X-Capgo-Signature': legacySignature,
  }

  if (deliveryVersion === 'standard') {
    const standardSignature = await generateStandardWebhookSignature(secret, eventId, timestamp, payloadString)
    headers['webhook-id'] = eventId
    headers['webhook-timestamp'] = timestamp
    headers['webhook-signature'] = standardSignature
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payloadString,
        redirect: 'manual',
        signal: controller.signal,
      })

      const responseBody = await readWebhookResponsePreview(response, WEBHOOK_RESPONSE_BODY_LIMIT_BYTES)
      const duration = Date.now() - startTime
      const retryAfter = response.headers.get('retry-after')

      cloudlog({
        requestId: c.get('requestId'),
        message: 'Webhook delivery attempt',
        deliveryId,
        urlInfo,
        status: response.status,
        success: response.ok,
        duration,
      })

      return {
        success: response.ok,
        status: response.status,
        body: responseBody,
        duration,
        retryAfter,
      }
    }
    finally {
      clearTimeout(timeoutId)
    }
  }
  catch (error) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Webhook delivery failed',
      deliveryId,
      urlInfo,
      error: errorMessage,
      duration,
    })

    return {
      success: false,
      body: 'Error: Webhook delivery failed',
      duration,
    }
  }
}

/**
 * Update delivery record with result
 */
export async function updateDeliveryResult(
  c: Context,
  deliveryId: string,
  success: boolean,
  responseStatus: number | null,
  responseBody: string | null,
  duration: number,
): Promise<void> {
  const { error } = await supabaseAdmin(c)
    .from('webhook_deliveries')
    .update({
      status: success ? 'success' : 'failed',
      response_status: responseStatus,
      response_body: responseBody,
      completed_at: new Date().toISOString(),
      duration_ms: duration,
    })
    .eq('id', deliveryId)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error updating delivery result', error: serializeError(error) })
  }
}

/**
 * Increment attempt count for a delivery
 */
export async function incrementAttemptCount(
  c: Context,
  deliveryId: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin(c)
    .from('webhook_deliveries')
    .select('attempt_count')
    .eq('id', deliveryId)
    .single()

  if (error || !data) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting attempt count', error: serializeError(error) })
    return 0
  }

  const newCount = data.attempt_count + 1

  await supabaseAdmin(c)
    .from('webhook_deliveries')
    .update({ attempt_count: newCount })
    .eq('id', deliveryId)

  return newCount
}

/**
 * Schedule a retry for a failed delivery
 */
export async function scheduleRetry(
  c: Context,
  deliveryId: string,
  attemptCount: number,
  retryAfter?: string | null,
  responseStatus?: number | null,
): Promise<number> {
  const retryDelaySeconds = getWebhookRetryDelaySeconds(attemptCount, retryAfter, responseStatus)
  const nextRetryAt = new Date(Date.now() + retryDelaySeconds * 1000).toISOString()

  const { error } = await supabaseAdmin(c)
    .from('webhook_deliveries')
    .update({
      next_retry_at: nextRetryAt,
      status: 'pending',
    })
    .eq('id', deliveryId)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error scheduling retry', error: serializeError(error) })
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Scheduled webhook retry',
    deliveryId,
    attemptCount,
    nextRetryAt,
    retryDelaySeconds,
    responseStatus,
  })

  return retryDelaySeconds
}

/**
 * Disable a webhook endpoint after an explicit receiver opt-out.
 */
export async function disableWebhook(
  c: Context,
  webhookId: string,
): Promise<void> {
  const { error } = await supabaseAdmin(c)
    .from('webhooks')
    .update({ enabled: false })
    .eq('id', webhookId)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error disabling webhook', error: serializeError(error) })
    return
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Disabled webhook endpoint',
    webhookId,
  })
}

/**
 * Mark a delivery as permanently failed
 */
export async function markDeliveryFailed(
  c: Context,
  deliveryId: string,
): Promise<void> {
  const { error } = await supabaseAdmin(c)
    .from('webhook_deliveries')
    .update({
      status: 'failed',
      next_retry_at: null,
    })
    .eq('id', deliveryId)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error marking delivery failed', error: serializeError(error) })
  }
}

/**
 * Get a webhook by ID with org management_email
 */
export async function getWebhookById(
  c: Context,
  webhookId: string,
) {
  const { data, error } = await supabaseAdmin(c)
    .from('webhooks')
    .select('*, orgs!inner(management_email)')
    .eq('id', webhookId)
    .single()

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting webhook', error: serializeError(error) })
    return null
  }

  return data
}

/**
 * Get a delivery by ID
 */
export async function getDeliveryById(
  c: Context,
  deliveryId: string,
) {
  const { data, error } = await supabaseAdmin(c)
    .from('webhook_deliveries')
    .select('*')
    .eq('id', deliveryId)
    .single()

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting delivery', error: serializeError(error) })
    return null
  }

  return data
}

/**
 * Create a test webhook payload
 */
export function createTestPayload(orgId: string): WebhookPayload {
  return {
    type: 'test.ping',
    event: 'test.ping',
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    org_id: orgId,
    data: {
      table: 'test',
      operation: 'TEST',
      record_id: 'test-record-id',
      old_record: null,
      new_record: {
        message: 'This is a test webhook from Capgo',
        timestamp: new Date().toISOString(),
      },
      changed_fields: null,
    },
  }
}

/**
 * Queue a webhook delivery message for processing using direct SQL via pg client
 */
export async function queueWebhookDelivery(
  c: Context,
  deliveryId: string,
  webhookId: string,
  url: string,
  payload: WebhookDeliveryPayload,
): Promise<void> {
  const message = {
    function_name: 'webhook_delivery',
    function_type: 'cloudflare',
    payload: {
      delivery_id: deliveryId,
      webhook_id: webhookId,
      url,
      payload,
    },
  }

  const db = getPgClient(c)
  try {
    await db.query(
      'SELECT pgmq.send($1, $2::jsonb)',
      ['webhook_delivery', JSON.stringify(message)],
    )
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Queued webhook delivery',
      deliveryId,
      webhookId,
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error queuing webhook delivery', error: serializeError(error) })
  }
  finally {
    closeClient(c, db)
  }
}

/**
 * Queue a webhook delivery with delay (for retries) using direct SQL via pg client
 */
export async function queueWebhookDeliveryWithDelay(
  c: Context,
  deliveryId: string,
  webhookId: string,
  url: string,
  payload: WebhookDeliveryPayload,
  delaySeconds: number,
): Promise<void> {
  const message = {
    function_name: 'webhook_delivery',
    function_type: 'cloudflare',
    payload: {
      delivery_id: deliveryId,
      webhook_id: webhookId,
      url,
      payload,
    },
  }

  const db = getPgClient(c)
  try {
    // pgmq.send with delay parameter
    await db.query(
      'SELECT pgmq.send($1::text, $2::jsonb, $3::integer)',
      ['webhook_delivery', JSON.stringify(message), delaySeconds],
    )
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Queued webhook delivery with delay',
      deliveryId,
      webhookId,
      delaySeconds,
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error queuing webhook delivery with delay, falling back to immediate', error: serializeError(error) })
    // Fallback to regular queue without delay
    try {
      await db.query(
        'SELECT pgmq.send($1, $2::jsonb)',
        ['webhook_delivery', JSON.stringify(message)],
      )
    }
    catch (fallbackError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error in fallback queue', error: serializeError(fallbackError) })
    }
  }
  finally {
    closeClient(c, db)
  }
}
