import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { purgeAppUpdatesCache } from '../utils/purgeUpdatesCache.ts'
import { checkPermission } from '../utils/rbac.ts'
import { hasPurgeTarget } from '../triggers/updates_cache_purge.ts'

interface PurgeBody {
  app_id?: string
}

async function canPurgeAppEdgeCache(c: Parameters<typeof checkPermission>[0], appId: string) {
  if (await checkPermission(c, 'app.update_settings', { appId }))
    return true
  return checkPermission(c, 'app.update_user_roles', { appId })
}

async function claimManualPurgeRateLimit(c: Parameters<typeof getPgClient>[0], appId: string): Promise<{ allowed: boolean, retryAfterSeconds?: number }> {
  let pg: Awaited<ReturnType<typeof getPgClient>> | null = null
  try {
    pg = await getPgClient(c)
    const { rows } = await pg.query<{ result: { allowed?: boolean, retry_after_seconds?: number } }>(
      'SELECT public.try_claim_manual_updates_edge_purge($1::text) AS result',
      [appId],
    )
    const result = rows[0]?.result
    if (result?.allowed)
      return { allowed: true }
    return {
      allowed: false,
      retryAfterSeconds: result?.retry_after_seconds ?? 60,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'manual updates edge purge rate limit failed', appId, error: serializeError(error) })
    throw simpleError('rate_limit_error', 'Could not verify purge rate limit')
  }
  finally {
    if (pg)
      closeClient(c, pg)
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<PurgeBody>(c)
  const appId = typeof body?.app_id === 'string' ? body.app_id.trim() : ''
  if (!appId)
    return quickError(400, 'missing_app_id', 'app_id is required')

  if (!(await canPurgeAppEdgeCache(c, appId)))
    return quickError(403, 'not_authorized', 'You can\'t purge the edge cache for this app', { app_id: appId })

  const claim = await claimManualPurgeRateLimit(c, appId)
  if (!claim.allowed)
    return quickError(429, 'purge_rate_limited', 'Edge cache purge is rate limited to once per minute per app', {
      app_id: appId,
      retryAfterSeconds: claim.retryAfterSeconds ?? 60,
    })

  if (!hasPurgeTarget(c))
    return quickError(503, 'purge_not_configured', 'Edge cache purge is not configured in this environment')

  const result = await purgeAppUpdatesCache(c, appId)
  cloudlog({
    requestId: c.get('requestId'),
    message: 'manual updates edge cache purge',
    appId,
    ...result,
  })

  if (result.nudged && !result.purged)
    return c.json({ ...BRES, nudged: result.nudged, purged: false, purged_apps: result.purgedApps, queued: true })

  return c.json({
    ...BRES,
    nudged: result.nudged,
    purged: result.purged,
    purged_apps: result.purgedApps,
  })
})