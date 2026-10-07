import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { CacheHelper } from '../utils/cache.ts'
import { quickError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { buildPlanValidationExpression, closeClient, getDrizzleClient, getPgClient, logPgError } from '../utils/pg.ts'
import * as schema from '../utils/postgres_schema.ts'
import { updatesAppCacheTag } from '../utils/updatesCacheTag.ts'
import { isStripeConfigured, isValidAppId } from '../utils/utils.ts'

// Website Live plugin endpoint. Devices in website mode only ask whether the
// app may update from its website and which URL to download from. The answer
// does not depend on the device, so it is cached per app id: in the Cloudflare
// snippet before routing, here in the Cache API, and by the device itself.
// It never touches the primary database and never writes anything.
export const app = new Hono<MiddlewareKeyVariables>()

const WEBSITE_LIVE_CACHE_PATH = '/.website-live-v1'
export const WEBSITE_LIVE_CACHE_TTL_SECONDS = 300
export const WEBSITE_LIVE_CHECK_INTERVAL_SECONDS = 600

export interface WebsiteLiveAppRow {
  update_mode: string | null
  website_url: string | null
  plan_valid: boolean
}

export interface WebsiteLiveResponse {
  allowed: boolean
  mode: 'website' | 'capgo'
  website_url?: string
  check_interval_seconds?: number
  reason?: 'full_capgo' | 'need_plan_upgrade' | 'missing_website_url'
}

/**
 * Unknown apps answer like full Capgo apps on purpose: the plugin then falls
 * back to /updates, which already owns on-prem handling, and this endpoint
 * does not become an app id existence oracle.
 */
export function buildWebsiteLiveResponse(row: WebsiteLiveAppRow | null, stripeConfigured = true): WebsiteLiveResponse {
  if (!row || row.update_mode !== 'website')
    return { allowed: false, mode: 'capgo', reason: 'full_capgo' }
  // Denials carry the interval too, so blocked devices back off as well.
  if (!row.website_url)
    return { allowed: false, mode: 'website', reason: 'missing_website_url', check_interval_seconds: WEBSITE_LIVE_CHECK_INTERVAL_SECONDS }
  if (!row.plan_valid && stripeConfigured)
    return { allowed: false, mode: 'website', reason: 'need_plan_upgrade', check_interval_seconds: WEBSITE_LIVE_CHECK_INTERVAL_SECONDS }
  return {
    allowed: true,
    mode: 'website',
    website_url: row.website_url,
    check_interval_seconds: WEBSITE_LIVE_CHECK_INTERVAL_SECONDS,
  }
}

async function queryWebsiteLiveApp(c: Context, appId: string): Promise<WebsiteLiveAppRow | null> {
  const pgClient = await getPgClient(c, true)
  try {
    const drizzleClient = getDrizzleClient(pgClient, { logger: false })
    // No usage action: Website Live is unlimited, only the subscription
    // (trial, paid, or credits) must be active.
    const planValid = buildPlanValidationExpression([], schema.apps.owner_org)
    // Release CI adds the columns to the replica subscriber before the
    // primary migration runs, so they can be selected directly.
    const row = await drizzleClient
      .select({
        update_mode: schema.apps.update_mode,
        website_url: schema.apps.website_url,
        plan_valid: planValid,
      })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, appId))
      .limit(1)
      .then(data => data[0])
    return row ?? null
  }
  finally {
    await closeClient(c, pgClient)
  }
}

function cacheHeaders(appId: string, ttlSeconds: number) {
  return {
    'Cache-Control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
    // Same tag as the app purge queue, for any CDN layer that stores the response.
    'Cache-Tag': updatesAppCacheTag(appId),
  }
}

app.get('/', async (c) => {
  const appId = c.req.query('app_id')?.trim() ?? ''
  if (!appId || !isValidAppId(appId))
    return quickError(400, 'invalid_app_id', 'app_id query parameter is missing or invalid')

  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(WEBSITE_LIVE_CACHE_PATH, { app_id: appId })
  const cached = await cache.matchJson<WebsiteLiveResponse>(cacheKey)
  if (cached) {
    c.header('X-Website-Live-Cache', 'hit')
    return c.json(cached, 200, cacheHeaders(appId, WEBSITE_LIVE_CACHE_TTL_SECONDS))
  }

  let row: WebsiteLiveAppRow | null
  try {
    row = await queryWebsiteLiveApp(c, appId)
  }
  catch (error) {
    logPgError(c, 'website_live', error, { appId })
    // Fail closed without caching: the device keeps its current bundle.
    return quickError(503, 'website_live_unavailable', 'Cannot check Website Live status')
  }

  const response = buildWebsiteLiveResponse(row, isStripeConfigured(c))
  cloudlog({ requestId: c.get('requestId'), message: 'website_live', app_id: appId, allowed: response.allowed, mode: response.mode, reason: response.reason })
  await cache.putJson(cacheKey, response, WEBSITE_LIVE_CACHE_TTL_SECONDS, { tags: [updatesAppCacheTag(appId)] })
  c.header('X-Website-Live-Cache', 'miss')
  return c.json(response, 200, cacheHeaders(appId, WEBSITE_LIVE_CACHE_TTL_SECONDS))
})
