import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

// OpenAI Ads Conversions API: https://developers.openai.com/ads/conversions-api
// Event schemas: https://developers.openai.com/ads/supported-events
const OPENAI_ADS_EVENTS_URL = 'https://bzr.openai.com/v1/events'
// Same Pixel ID as the website measurement pixel; events must share it to deduplicate.
const DEFAULT_OPENAI_ADS_PIXEL_ID = '5Fiq7Kwp18THe1MThKS7GL'
const REGISTRATION_SOURCE_URL = 'https://capgo.app/register/'
// Used when WEBAPP_URL (the console, whose plans page starts the first payment) is not a public https URL.
const DEFAULT_SUBSCRIPTION_SOURCE_URL = 'https://capgo.app/'
// The API rejects events older than 7 days; keep a margin for clock skew.
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000
// Retries stay inside the ~30s background-task budget: 3 x 8s timeout + 2.5s of waits.
const OPENAI_ADS_TIMEOUT_MS = 8_000
const DEFAULT_RETRY_DELAYS_MS = [500, 2_000]

type UserRow = Database['public']['Tables']['users']['Row']
export type OpenAIAdsUserRecord = Pick<UserRow, 'id' | 'email' | 'first_name' | 'last_name' | 'country'>
type OpenAIRegistrationRecord = OpenAIAdsUserRecord & Pick<UserRow, 'created_at'>

export interface OpenAIAdsEvent {
  id: string
  type: 'registration_completed' | 'subscription_created'
  timestamp_ms: number
  source_url: string
  action_source: 'web'
  user: Record<string, string[]>
  data: Record<string, string | number>
}

interface SendOptions {
  retryDelaysMs?: number[]
  /** Epoch ms after which no attempt starts and no request runs, shared with work done before the send. */
  deadlineMs?: number
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

const ASCII_PUNCTUATION_OR_WHITESPACE = /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g

// Lowercase, drop whitespace and ASCII punctuation, keep non-ASCII characters.
export function normalizeOpenAIName(name: string): string {
  return name.toLowerCase().replace(ASCII_PUNCTUATION_OR_WHITESPACE, '')
}

/**
 * Hashed matching data for one Capgo user. `external_ids_sha256` is the hash of
 * the user id, the same value the website pixel and the registration event use,
 * so every conversion of one user is attributed to the same person.
 */
export async function buildOpenAIAdsUser(record: OpenAIAdsUserRecord): Promise<Record<string, string[]>> {
  const user: Record<string, string[]> = {
    external_ids_sha256: [await sha256Hex(record.id.trim())],
  }
  const email = (record.email ?? '').trim().toLowerCase()
  if (email)
    user.emails_sha256 = [await sha256Hex(email)]
  const firstName = normalizeOpenAIName(record.first_name ?? '')
  if (firstName)
    user.first_names_sha256 = [await sha256Hex(firstName)]
  const lastName = normalizeOpenAIName(record.last_name ?? '')
  if (lastName)
    user.last_names_sha256 = [await sha256Hex(lastName)]
  const country = (record.country ?? '').trim()
  if (/^[a-z]{2}$/i.test(country))
    user.countries = [country.toUpperCase()]
  return user
}

function parseTimestamp(value: string | null | undefined, now: number): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed))
    return null
  return Math.min(parsed, now)
}

export async function buildOpenAIRegistrationEvent(record: OpenAIRegistrationRecord, now = Date.now()): Promise<OpenAIAdsEvent | null> {
  // Without a real creation time, a late trigger would report an old signup as new.
  const timestampMs = parseTimestamp(record.created_at, now)
  if (timestampMs === null)
    return null
  const user = await buildOpenAIAdsUser(record)

  return {
    // Matches the pixel event_id `registration_<sha256(user id)>` for deduplication.
    id: `registration_${user.external_ids_sha256[0]}`,
    type: 'registration_completed',
    timestamp_ms: timestampMs,
    source_url: REGISTRATION_SOURCE_URL,
    action_source: 'web',
    user,
    data: { type: 'customer_action' },
  }
}

export interface OpenAISubscriptionInput {
  orgId: string
  /** The org owner, who signed up and pays: hashed like the registration event. */
  user: OpenAIAdsUserRecord
  /** When the first payment happened (stripe_info.paid_at). */
  paidAt: string
  /** Plan name, or the Stripe price id when the plan is unknown. */
  planId?: string | null
  /** Amount actually paid, in the currency's minor unit (Stripe `amount_paid`). */
  amount?: number | null
  currency?: string | null
  sourceUrl?: string | null
}

/** ISO 4217 code in uppercase, or null when the value is not a 3-letter code. */
export function normalizeOpenAICurrency(currency: string | null | undefined): string | null {
  const code = (currency ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

export async function buildOpenAISubscriptionEvent(input: OpenAISubscriptionInput, now = Date.now()): Promise<OpenAIAdsEvent | null> {
  const timestampMs = parseTimestamp(input.paidAt, now)
  if (timestampMs === null)
    return null
  const data: Record<string, string | number> = { type: 'plan_enrollment' }
  const planId = (input.planId ?? '').trim()
  if (planId)
    data.plan_id = planId
  // `currency` is required when `amount` is sent; send both or neither.
  const currency = normalizeOpenAICurrency(input.currency)
  if (currency && typeof input.amount === 'number' && Number.isSafeInteger(input.amount) && input.amount >= 0) {
    data.amount = input.amount
    data.currency = currency
  }

  return {
    // One first payment per org: retries and later webhooks reuse this id, so
    // OpenAI keeps only the first event.
    id: `subscription_${await sha256Hex(input.orgId.trim())}`,
    type: 'subscription_created',
    timestamp_ms: timestampMs,
    source_url: input.sourceUrl || DEFAULT_SUBSCRIPTION_SOURCE_URL,
    action_source: 'web',
    user: await buildOpenAIAdsUser(input.user),
    data,
  }
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}

function getOpenAIAdsConfig(c: Context) {
  const apiKey = getEnv(c, 'OPENAI_ADS_API_KEY').trim()
  if (!apiKey)
    return null
  return { apiKey, pixelId: getEnv(c, 'OPENAI_ADS_PIXEL_ID').trim() || DEFAULT_OPENAI_ADS_PIXEL_ID }
}

/**
 * Post one event to the Conversions API.
 * Retries network errors, 408, 429 and 5xx a bounded number of times; the event id stays
 * the same, so a retry after a lost response does not create a duplicate.
 */
async function postOpenAIAdsEvent(
  c: Context,
  config: { apiKey: string, pixelId: string },
  event: OpenAIAdsEvent,
  label: string,
  logContext: Record<string, unknown>,
  retryDelaysMs: number[],
  now: number,
  deadlineMs: number | undefined,
): Promise<boolean> {
  if (now - event.timestamp_ms > MAX_EVENT_AGE_MS) {
    cloudlog({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} skipped: event older than 7 days`, ...logContext })
    return false
  }

  const url = new URL(OPENAI_ADS_EVENTS_URL)
  url.searchParams.set('pid', config.pixelId)
  const body = JSON.stringify({ events: [event] })

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    // A shared deadline caps the request timeout and stops further attempts.
    const remainingMs = deadlineMs === undefined ? OPENAI_ADS_TIMEOUT_MS : deadlineMs - Date.now()
    if (remainingMs < 1_000) {
      cloudlogErr({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} event skipped: background budget exhausted`, ...logContext, attempt: attempt + 1 })
      return false
    }
    const isLastAttempt = attempt === retryDelaysMs.length
    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(Math.min(OPENAI_ADS_TIMEOUT_MS, remainingMs)),
      })
      if (response.ok) {
        await response.body?.cancel().catch(() => {})
        cloudlog({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} event sent`, ...logContext, attempt: attempt + 1 })
        return true
      }
      const responseBody = await response.text().catch(() => '')
      if (isLastAttempt || !isRetryableStatus(response.status)) {
        cloudlogErr({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} event failed`, ...logContext, status: response.status, attempt: attempt + 1, body: responseBody.slice(0, 500) })
        return false
      }
    }
    catch (error) {
      if (isLastAttempt) {
        cloudlogErr({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} event error`, ...logContext, attempt: attempt + 1, error: serializeError(error) })
        return false
      }
    }
    await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]))
  }
  return false
}

/**
 * Build and send one conversion. No-op when OPENAI_ADS_API_KEY is missing.
 * Never throws, so it is safe inside backgroundTask and webhooks.
 */
async function trackOpenAIAdsEvent(
  c: Context,
  label: string,
  logContext: Record<string, unknown>,
  build: (now: number) => Promise<OpenAIAdsEvent | null>,
  { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, deadlineMs }: SendOptions,
): Promise<boolean> {
  try {
    const config = getOpenAIAdsConfig(c)
    if (!config)
      return false
    const now = Date.now()
    const event = await build(now)
    if (!event) {
      cloudlog({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} skipped: unknown event time`, ...logContext })
      return false
    }
    return await postOpenAIAdsEvent(c, config, event, label, logContext, retryDelaysMs, now, deadlineMs)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: `OpenAI Ads ${label} event error`, ...logContext, error: serializeError(error) })
    return false
  }
}

/** Send the server-side `registration_completed` conversion to OpenAI Ads. Never throws. */
export async function trackOpenAIRegistration(
  c: Context,
  record: OpenAIRegistrationRecord,
  options: SendOptions = {},
): Promise<boolean> {
  return trackOpenAIAdsEvent(c, 'registration', { userId: record.id }, now => buildOpenAIRegistrationEvent(record, now), options)
}

/**
 * Send the server-side `subscription_created` conversion for an org's first
 * payment. Sent for every first payment (direct offer or converted trial);
 * Ads Manager decides which event a campaign optimizes for. Never throws.
 */
export async function trackOpenAISubscription(
  c: Context,
  input: OpenAISubscriptionInput,
  options: SendOptions = {},
): Promise<boolean> {
  return trackOpenAIAdsEvent(c, 'subscription', { orgId: input.orgId, userId: input.user.id }, now => buildOpenAISubscriptionEvent(input, now), options)
}

/** The console plans page (where the first payment starts), from WEBAPP_URL when it is a public https URL. */
export function getOpenAISubscriptionSourceUrl(c: Context): string {
  try {
    const base = new URL(getEnv(c, 'WEBAPP_URL'))
    if (base.protocol !== 'https:')
      return DEFAULT_SUBSCRIPTION_SOURCE_URL
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/settings/organization/plans`
    base.search = ''
    base.hash = ''
    return base.href
  }
  catch {
    return DEFAULT_SUBSCRIPTION_SOURCE_URL
  }
}

/** Whether the Conversions API is configured, so callers can skip lookups when it is not. */
export function isOpenAIAdsConfigured(c: Context): boolean {
  return getEnv(c, 'OPENAI_ADS_API_KEY').trim() !== ''
}
