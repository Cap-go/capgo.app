import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { quickError } from '../../utils/hono.ts'
import { prewarmPluginStateRegions } from '../../utils/pluginStatePrewarm.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { isValidAppId } from '../../utils/utils.ts'

/**
 * POST /app/:id/prewarm: load the app's published plugin state into every
 * plugin region's cache now (the `app prewarm` CLI command). Publications
 * already prewarm automatically after their purge; this is the manual trigger.
 */
export async function prewarm(c: Context<MiddlewareKeyVariables>, appId: string): Promise<Response> {
  if (!appId || !isValidAppId(appId))
    throw quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
  if (!(await checkPermission(c, 'app.upload_bundle', { appId })))
    throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
  const regions = await prewarmPluginStateRegions(c, [appId])
  return c.json({
    app_id: appId,
    regions: regions.map((region) => {
      const result = region.results.find(entry => entry.app_id === appId)
      return {
        region: region.region,
        placement: region.placement,
        revision: result?.revision ?? null,
        cached: result?.cached ?? 0,
        skipped: result?.skipped ?? null,
        error: region.error ?? result?.error ?? null,
      }
    }),
  })
}
