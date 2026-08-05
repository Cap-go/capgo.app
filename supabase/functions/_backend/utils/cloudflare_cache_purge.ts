import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

function parseZoneIds(raw: string): string[] {
  return raw
    .split(',')
    .map(zoneId => zoneId.trim())
    .filter(Boolean)
}

export function buildOnPremCacheTag(appId: string) {
  return `app-onprem-v2:${appId}`
}

export function buildPlanCacheTag(appId: string) {
  return `app-plan-v2:${appId}`
}

async function purgeByTags(c: Context, tags: string[]) {
  // Only run on Cloudflare Workers runtime
  if (getRuntimeKey() !== 'workerd') {
    cloudlog({ requestId: c.get('requestId'), message: 'Cloudflare cache purge skipped (not running on Cloudflare Workers)' })
    return
  }

  const token = getEnv(c, 'CF_CACHE_PURGE_TOKEN')
  const zoneIdsRaw = getEnv(c, 'CF_CACHE_PURGE_ZONE_IDS')

  if (!token || !zoneIdsRaw) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cloudflare cache purge skipped (missing env)', hasToken: Boolean(token), hasZoneIds: Boolean(zoneIdsRaw) })
    return
  }

  const zoneIds = parseZoneIds(zoneIdsRaw)
  if (!zoneIds.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cloudflare cache purge skipped (no zone IDs)', zoneIdsRaw })
    return
  }

  const body = JSON.stringify({ tags })
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Capgo/1.0',
  }

  await Promise.all(zoneIds.map(async (zoneId) => {
    try {
      const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        headers,
        body,
      })

      if (!response.ok) {
        const error = await response.json().catch(() => null)
        cloudlogErr({ requestId: c.get('requestId'), message: 'Cloudflare cache purge failed', zoneId, status: response.status, error })
        return
      }

      const result = await response.json().catch(() => null) as { success?: boolean } | null
      if (result?.success === false) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Cloudflare cache purge returned error', zoneId, result })
        return
      }

      cloudlog({ requestId: c.get('requestId'), message: 'Cloudflare cache purged by tag', zoneId, tags })
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cloudflare cache purge error', zoneId, error: serializeError(error) })
    }
  }))
}

/**
 * Purge on-prem cache for an app.
 * Call this when an app is created to clear any stale on_premise_app responses.
 */
export async function purgeOnPremCache(c: Context, appId: string) {
  const tags = [buildOnPremCacheTag(appId)]
  await purgeByTags(c, tags)
}

/**
 * Purge plan-upgrade cache for an app.
 * Call this when payment succeeds to clear any stale need_plan_upgrade responses.
 */
export async function purgePlanCache(c: Context, appId: string) {
  const tags = [buildPlanCacheTag(appId)]
  await purgeByTags(c, tags)
}

/**
 * Purge plan-upgrade cache for all apps in an organization.
 * Call this when a subscription payment succeeds.
 */
export async function purgePlanCacheForOrg(c: Context, orgId: string) {
  // Get all app_ids for this org
  const { data: apps, error } = await supabaseAdmin(c)
    .from('apps')
    .select('app_id')
    .eq('owner_org', orgId)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to fetch apps for org cache purge', orgId, error })
    return
  }

  if (!apps || apps.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'No apps found for org cache purge', orgId })
    return
  }

  // Build tags for all apps in the org
  const tags = apps.map(app => buildPlanCacheTag(app.app_id))
  cloudlog({ requestId: c.get('requestId'), message: 'Purging plan cache for org apps', orgId, appCount: apps.length })
  await purgeByTags(c, tags)
}

/**
 * Purge on-prem cache for all apps in an organization.
 * Call this when a subscription payment succeeds so cancelled→valid apps
 * are not stuck on cached on_premise_app 429s for the full Retry-After TTL.
 */
export async function purgeOnPremCacheForOrg(c: Context, orgId: string) {
  const { data: apps, error } = await supabaseAdmin(c)
    .from('apps')
    .select('app_id')
    .eq('owner_org', orgId)

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to fetch apps for org on-prem cache purge', orgId, error })
    return
  }

  if (!apps || apps.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'No apps found for org on-prem cache purge', orgId })
    return
  }

  const tags = apps.map(app => buildOnPremCacheTag(app.app_id))
  cloudlog({ requestId: c.get('requestId'), message: 'Purging on-prem cache for org apps', orgId, appCount: apps.length })
  await purgeByTags(c, tags)
}

