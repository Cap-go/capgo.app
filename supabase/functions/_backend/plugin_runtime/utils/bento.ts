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

async function bentoFetch(c: Context, path: string, siteUuid: string, body: any) {
  const headers = getBentoHeaders(c)
  if (!headers)
    return null

  const url = new URL(`https://app.bentonow.com/api/v1/${path}`)
  url.searchParams.set('site_uuid', siteUuid)

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Bento API error: ${response.status} ${error}`)
  }

  return response.json()
}

// Only use this function when a specific member of the organization needs to be tracked in Bento. For organization-level events, use sendNotifToOrgMembers in org_email_notifications.ts which will call trackBentoEvent for each member with an email in the background.
export async function trackBentoEvent(c: Context, email: string, data: any, event: string) {
  if (!isBentoConfigured(c))
    return

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')

    const payload = {
      events: [{
        type: event,
        email,
        details: data,
      }],
    }

    const res = await bentoFetch(c, 'batch/events', siteUuid, payload) as { results: number, failed: number }
    if (res.failed > 0) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'trackBentoEvent', error: res })
      return false
    }
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackBentoEvent error', error: serializeError(e) })
    return false
  }
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
      const res = await bentoFetch(c, 'batch/subscribers', siteUuid, payload) as { results?: number, failed?: number, errors?: unknown }
      if (res?.failed && res.failed > 0) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'syncBentoSubscriberTags', error: res })
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

export async function unsubscribeBento(c: Context, email: string) {
  if (!isBentoConfigured(c))
    return

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
    const command = {
      command: 'unsubscribe',
      email,
    }

    const result = await bentoFetch(c, 'fetch/commands', siteUuid, { command })

    cloudlog({ requestId: c.get('requestId'), message: 'unsubscribeBento', email, result })
    return true
  }
  catch (e) {
    cloudlog({ requestId: c.get('requestId'), message: 'unsubscribeBento error', error: e })
    return false
  }
}
