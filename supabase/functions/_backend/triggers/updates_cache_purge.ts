// Purges the /updates edge cache of the given apps in every Cloudflare data
// center (zone purge-by-tag, 100 tags per API call).
//
// Called through pg_net by public.flush_updates_cache_purge(), which batches
// every due app (right after a change, then again 10s / 60s / 180s later so an
// entry refilled from a lagging read replica cannot outlive the change) into
// one request. Changes that arrive during the 1s flush throttle are drained
// by this endpoint calling the flush again ~1s later (the chain stops once
// nothing is due). Every failure is soft: the cache TTL is the backstop.

import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { updatesAppCacheTag } from '../plugin_runtime/utils/updatesCacheTag.ts'
import { BRES, middlewareAPISecret, parseBody } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { backgroundTask, getEnv } from '../utils/utils.ts'

/** Cloudflare purge API accepts at most 100 tags per call on every plan. */
const PURGE_TAGS_PER_CALL = 100
const MAX_APPS_PER_REQUEST = 1000
const PURGE_TIMEOUT_MS = 5000
const MAX_RETRY_AFTER_MS = 2000
const MAX_PURGE_ATTEMPTS = 3
/** Just over the DB flush throttle (1s), so the follow-up flush is allowed. */
const FOLLOW_UP_FLUSH_DELAY_MS = 1100

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size))
  return chunks
}

export function parseCsv(raw: string): string[] {
  return raw.split(',').map(value => value.trim()).filter(Boolean)
}

export function parseAppIds(body: unknown): string[] {
  const appIds = body && typeof body === 'object' && Array.isArray((body as { app_ids?: unknown }).app_ids)
    ? (body as { app_ids: unknown[] }).app_ids
    : []
  return [...new Set(appIds.filter((appId): appId is string => typeof appId === 'string' && appId.length > 0))].slice(0, MAX_APPS_PER_REQUEST)
}

async function postPurge(url: string, headers: Record<string, string>, body: unknown) {
  const send = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
  })
  let response = await send()
  // Purge API token bucket: wait for the advertised refill, a few times.
  for (let attempt = 1; response.status === 429 && attempt < MAX_PURGE_ATTEMPTS; attempt++) {
    const retryAfterMs = Math.min(Number(response.headers.get('Retry-After') ?? '1') * 1000 || 1000, MAX_RETRY_AFTER_MS)
    await new Promise(resolve => setTimeout(resolve, retryAfterMs))
    response = await send()
  }
  return response
}

export async function purgeUpdatesCacheTags(c: Context, tags: string[]) {
  const token = getEnv(c, 'CF_CACHE_PURGE_TOKEN')
  const zoneIds = parseCsv(getEnv(c, 'CF_CACHE_PURGE_ZONE_IDS'))
  const localPurgeUrl = getEnv(c, 'UPDATES_CACHE_LOCAL_PURGE_URL')
  let calls = 0
  let failed = 0

  const run = async (url: string, headers: Record<string, string>, body: unknown) => {
    calls++
    try {
      const response = await postPurge(url, headers, body)
      if (!response.ok) {
        failed++
        cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge failed', url, status: response.status, tags: Array.isArray((body as { tags?: unknown }).tags) ? (body as { tags: unknown[] }).tags.length : 0 })
      }
    }
    catch (error) {
      failed++
      cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge error', url, error: serializeError(error) })
    }
  }

  const jobs: Promise<void>[] = []
  if (token && zoneIds.length > 0) {
    for (const zoneId of zoneIds) {
      for (const tagChunk of chunk(tags, PURGE_TAGS_PER_CALL)) {
        jobs.push(run(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`, { Authorization: `Bearer ${token}` }, { tags: tagChunk }))
      }
    }
  }
  if (localPurgeUrl)
    jobs.push(run(localPurgeUrl, { apisecret: getEnv(c, 'API_SECRET') }, { tags }))
  await Promise.all(jobs)
  return { calls, failed }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<unknown>(c).catch(() => null)
  const appIds = parseAppIds(body)
  if (appIds.length === 0)
    return c.json({ ...BRES, apps: 0 })

  const tags = appIds.map(updatesAppCacheTag)
  // Answer pg_net / the queue right away; the purge (and 429 back-off) runs
  // in the background, bounded well under the 30s waitUntil budget.
  await backgroundTask(c, (async () => {
    const result = await purgeUpdatesCacheTags(c, tags)
    if (result.calls === 0)
      cloudlog({ requestId: c.get('requestId'), message: 'updates cache purge skipped (not configured)', apps: appIds.length })
    else
      cloudlog({ requestId: c.get('requestId'), message: 'updates cache purged', apps: appIds.length, calls: result.calls, failed: result.failed })
    // Drain changes that were throttled while this flush ran.
    await new Promise(resolve => setTimeout(resolve, FOLLOW_UP_FLUSH_DELAY_MS))
    const { error } = await supabaseAdmin(c).rpc('flush_updates_cache_purge', { p_force: false })
    if (error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache follow-up flush failed', error: serializeError(error) })
  })())
  return c.json({ ...BRES, apps: appIds.length })
})
