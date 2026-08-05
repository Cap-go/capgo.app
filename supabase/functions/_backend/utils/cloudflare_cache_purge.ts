import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { getEnv } from './utils.ts'

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
/** Cloudflare purge_cache by tags accepts at most 100 tags per request. */
const CF_PURGE_TAG_BATCH_SIZE = 100

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

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Capgo/1.0',
  }

  for (let offset = 0; offset < tags.length; offset += CF_PURGE_TAG_BATCH_SIZE) {
    const batch = tags.slice(offset, offset + CF_PURGE_TAG_BATCH_SIZE)
    const body = JSON.stringify({ tags: batch })

    await Promise.all(zoneIds.map(async (zoneId) => {
      try {
        const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/purge_cache`, {
          method: 'POST',
          headers,
          body,
        })

        if (!response.ok) {
          const error = await response.json().catch(() => null)
          cloudlogErr({ requestId: c.get('requestId'), message: 'Cloudflare cache purge failed', zoneId, status: response.status, error, tagCount: batch.length })
          return
        }

        const result = await response.json().catch(() => null) as { success?: boolean } | null
        if (result?.success === false) {
          cloudlogErr({ requestId: c.get('requestId'), message: 'Cloudflare cache purge returned error', zoneId, result, tagCount: batch.length })
          return
        }

        cloudlog({ requestId: c.get('requestId'), message: 'Cloudflare cache purged by tag', zoneId, tagCount: batch.length, tagOffset: offset })
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Cloudflare cache purge error', zoneId, error: serializeError(error) })
      }
    }))
  }
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
 * List all app_ids for an org (single SQL via pg — no PostgREST page cap).
 */
async function listOrgAppIds(c: Context, orgId: string): Promise<string[] | null> {
  const pg = getPgClient(c, true)
  try {
    const result = await pg.query<{ app_id: string }>(
      'SELECT app_id FROM public.apps WHERE owner_org = $1::uuid ORDER BY app_id',
      [orgId],
    )
    return result.rows.map(row => row.app_id).filter(Boolean)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to fetch apps for org cache purge', orgId, error: serializeError(error) })
    return null
  }
  finally {
    closeClient(c, pg)
  }
}

async function purgeCacheTagsForOrg(
  c: Context,
  orgId: string,
  buildTag: (appId: string) => string,
  logLabel: string,
) {
  const appIds = await listOrgAppIds(c, orgId)
  if (appIds === null)
    return

  if (appIds.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: `No apps found for org ${logLabel} cache purge`, orgId })
    return
  }

  const tags = appIds.map(buildTag)
  cloudlog({ requestId: c.get('requestId'), message: `Purging ${logLabel} cache for org apps`, orgId, appCount: appIds.length, tagBatches: Math.ceil(tags.length / CF_PURGE_TAG_BATCH_SIZE) })
  await purgeByTags(c, tags)
}

/**
 * Purge plan-upgrade cache for all apps in an organization.
 * Call this when a subscription payment succeeds.
 */
export async function purgePlanCacheForOrg(c: Context, orgId: string) {
  await purgeCacheTagsForOrg(c, orgId, buildPlanCacheTag, 'plan')
}

/**
 * Purge on-prem cache for all apps in an organization.
 * Call this when a subscription payment succeeds so cancelled→valid apps
 * are not stuck on cached on_premise_app 429s for the full Retry-After TTL.
 */
export async function purgeOnPremCacheForOrg(c: Context, orgId: string) {
  await purgeCacheTagsForOrg(c, orgId, buildOnPremCacheTag, 'on-prem')
}
