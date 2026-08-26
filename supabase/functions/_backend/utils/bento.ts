import type { Context } from 'hono'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

export function isBentoConfigured(c: Context) {
  const publishableKey = (getEnv(c, 'BENTO_PUBLISHABLE_KEY') || '').trim()
  const secretKey = (getEnv(c, 'BENTO_SECRET_KEY') || '').trim()
  const siteUuid = (getEnv(c, 'BENTO_SITE_UUID') || '').trim()

  if (!publishableKey || !secretKey || !siteUuid)
    return false

  // CI sometimes sets placeholder values like "test" which should not trigger
  // outbound Bento requests or related DB work.
  const placeholders = new Set(['test', 'TEST', 'placeholder', 'changeme'])
  if (placeholders.has(publishableKey) || placeholders.has(secretKey) || placeholders.has(siteUuid))
    return false

  return true
}

function getBentoHeaders(c: Context) {
  if (!isBentoConfigured(c)) {
    cloudlog({ requestId: c.get('requestId'), context: 'getBentoHeaders', error: 'Bento is not enabled' })
    return null
  }

  const publishableKey = getEnv(c, 'BENTO_PUBLISHABLE_KEY')
  const secretKey = getEnv(c, 'BENTO_SECRET_KEY')

  const authKey = btoa(`${publishableKey}:${secretKey}`)

  return {
    'Authorization': `Basic ${authKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'Capgo',
  }
}

function bentoApiUrl(path: string, siteUuid: string, query?: Record<string, string>) {
  const url = new URL(`https://app.bentonow.com/api/v1/${path}`)
  url.searchParams.set('site_uuid', siteUuid)
  if (query) {
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value)
  }
  return url
}

async function readBentoJson(response: Response) {
  if (!response.ok) {
    try {
      await response.body?.cancel()
    }
    catch {
      // Preserve the sanitized status error when stream cleanup fails.
    }
    throw new Error(`Bento API error: ${response.status}`)
  }

  try {
    return await response.json()
  }
  catch {
    throw new Error(`Bento API returned invalid JSON: ${response.status}`)
  }
}

async function bentoFetch(c: Context, path: string, siteUuid: string, body: any, signal?: AbortSignal) {
  const headers = getBentoHeaders(c)
  if (!headers)
    return null

  const response = await fetch(bentoApiUrl(path, siteUuid).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  return await readBentoJson(response)
}

async function bentoGet(c: Context, path: string, siteUuid: string, query: Record<string, string>, signal?: AbortSignal) {
  const headers = getBentoHeaders(c)
  if (!headers)
    return null

  const response = await fetch(bentoApiUrl(path, siteUuid, query).toString(), {
    method: 'GET',
    headers,
    signal,
  })

  if (response.status === 404) {
    try {
      await response.body?.cancel()
    }
    catch {
      // Unknown subscriber — treat as a miss, not a transport failure.
    }
    return null
  }

  return await readBentoJson(response)
}

export function parseBentoSubscriberEmail(result: unknown): string | null {
  if (!result || typeof result !== 'object')
    return null

  const data = (result as { data?: unknown }).data
  if (!data || typeof data !== 'object')
    return null

  const attributes = (data as { attributes?: unknown }).attributes
  if (!attributes || typeof attributes !== 'object')
    return null

  const email = (attributes as { email?: unknown }).email
  if (typeof email !== 'string')
    return null

  const normalized = email.trim().toLowerCase()
  return normalized.includes('@') ? normalized : null
}

/**
 * Resolve a Bento visitor UUID to an email.
 * `undefined` means Bento is off or the lookup failed; `null` means no subscriber.
 */
export async function getBentoSubscriberEmailByUuid(
  c: Context,
  uuid: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  if (!isBentoConfigured(c))
    return undefined

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
    const result = await bentoGet(c, 'fetch/subscribers', siteUuid, { uuid }, signal)
    if (result == null)
      return null
    return parseBentoSubscriberEmail(result)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getBentoSubscriberEmailByUuid error',
      error: serializeError(error),
    })
    return undefined
  }
}

function acceptedBentoBatchResult(result: unknown, expectedResults: number) {
  if (!result || typeof result !== 'object')
    return false

  const response = result as { failed?: unknown, results?: unknown }
  return response.results === expectedResults && response.failed === 0
}

function bentoBatchResultSummary(result: unknown): { failed?: number, results?: number } {
  if (!result || typeof result !== 'object')
    return {}

  const response = result as { failed?: unknown, results?: unknown }
  return {
    ...(typeof response.failed === 'number' && Number.isFinite(response.failed) ? { failed: response.failed } : {}),
    ...(typeof response.results === 'number' && Number.isFinite(response.results) ? { results: response.results } : {}),
  }
}

function acceptedBentoCommandResult(result: unknown, expectedResults: number) {
  if (!result || typeof result !== 'object')
    return false

  return (result as { results?: unknown }).results === expectedResults
}

export interface BentoBatchEvent {
  data: Record<string, unknown>
  event: string
}

export async function trackBentoEvents(
  c: Context,
  email: string,
  events: readonly BentoBatchEvent[],
  signal?: AbortSignal,
) {
  if (!isBentoConfigured(c))
    return
  if (events.length === 0)
    return true

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
    const payload = {
      events: events.map(item => ({
        type: item.event,
        email,
        details: item.data,
      })),
    }
    const res = await bentoFetch(c, 'batch/events', siteUuid, payload, signal)
    if (!acceptedBentoBatchResult(res, payload.events.length)) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'trackBentoEvents', error: bentoBatchResultSummary(res) })
      return false
    }
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackBentoEvents error', error: serializeError(error) })
    return false
  }
}

// Only use this function when a specific member of the organization needs to be tracked in Bento. For organization-level events, use sendNotifToOrgMembers in org_email_notifications.ts which will call trackBentoEvent for each member with an email in the background.
export async function trackBentoEvent(
  c: Context,
  email: string,
  data: Record<string, unknown>,
  event: string,
  signal?: AbortSignal,
) {
  return trackBentoEvents(c, email, [{ data, event }], signal)
}

export async function addTagBento(c: Context, email: string, segments: { segments: string[], deleteSegments: string[] }) {
  if (!isBentoConfigured(c))
    return

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')

    const commands = [
      ...segments.deleteSegments.map(segment => ({
        command: 'remove_tag',
        email,
        query: segment,
      })),
      ...segments.segments.map(segment => ({
        command: 'add_tag',
        email,
        query: segment,
      })),
    ]

    const results = await Promise.all(commands.map(command =>
      bentoFetch(c, 'fetch/commands', siteUuid, { command }),
    ))

    cloudlog({ requestId: c.get('requestId'), message: 'addTagBento', email, commands, results })
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'addTagBento error', error: serializeError(e) })
    return false
  }
}

export async function syncBentoSubscriberTags(
  c: Context,
  update: { email: string, segments: string[], deleteSegments: string[] } | Array<{ email: string, segments: string[], deleteSegments: string[] }>,
  signal?: AbortSignal,
) {
  if (!isBentoConfigured(c))
    return

  const updates = Array.isArray(update) ? update : [update]
  const subscribers = updates
    .filter(item => item.segments.length > 0 || item.deleteSegments.length > 0)
    .map((item) => {
      const tags = item.segments.join(',')
      const removeTags = item.deleteSegments.join(',')
      return {
        email: item.email,
        ...(tags ? { tags } : {}),
        ...(removeTags ? { remove_tags: removeTags } : {}),
      }
    })

  if (subscribers.length === 0)
    return true

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
    const chunkSize = 1000
    for (let i = 0; i < subscribers.length; i += chunkSize) {
      const chunk = subscribers.slice(i, i + chunkSize)
      const payload = { subscribers: chunk }
      const res = await bentoFetch(c, 'batch/subscribers', siteUuid, payload, signal)
      if (!acceptedBentoBatchResult(res, chunk.length)) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'syncBentoSubscriberTags', error: bentoBatchResultSummary(res) })
        return false
      }
    }
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'syncBentoSubscriberTags error', error: serializeError(e) })
    return false
  }
}

export async function unsubscribeBento(c: Context, email: string, signal?: AbortSignal) {
  if (!isBentoConfigured(c))
    return

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
    const command = {
      command: 'unsubscribe',
      email,
    }

    const result = await bentoFetch(c, 'fetch/commands', siteUuid, { command }, signal)

    if (!acceptedBentoCommandResult(result, 1)) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'unsubscribeBento rejected', error: result })
      return false
    }
    cloudlog({ requestId: c.get('requestId'), message: 'unsubscribeBento', email, result })
    return true
  }
  catch (e) {
    cloudlog({ requestId: c.get('requestId'), message: 'unsubscribeBento error', error: e })
    return false
  }
}
