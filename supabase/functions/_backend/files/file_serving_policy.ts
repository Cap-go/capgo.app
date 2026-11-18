import type { Context } from 'hono'
import { parsePreviewHostname } from '../../shared/preview-subdomain.ts'
import { quickError } from '../plugin_runtime/utils/hono.ts'
import { enforceServingPolicy, requestServingPolicy } from '../plugin_runtime/utils/servingPolicy.ts'
import { isRestrictedServingPolicy } from '../plugin_runtime/utils/servingRegions.ts'
import { servingRegionReaderEpoch } from '../plugin_runtime/utils/servingRegionRollout.js'
import { parseAppScopedAttachmentPath } from './util.ts'

/** Use the actual storage key, never a caller's app_id or hostname. */
export async function enforceFileServingPolicy(c: Context, fileId: string) {
  if (!servingRegionReaderEpoch)
    return
  const scope = parseAppScopedAttachmentPath(fileId)
  if (scope?.kind !== 'scoped')
    throw quickError(503, 'serving_policy_unavailable', 'File delivery policy unavailable')
  await enforceServingPolicy(c, scope.app_id)
}

/** Public previews must not become another bundle download ingress. */
export async function enforcePreviewServingPolicy(c: Context) {
  if (!servingRegionReaderEpoch)
    return
  const preview = parsePreviewHostname(c.req.header('host') || new URL(c.req.url).hostname)
  if (!preview)
    throw quickError(503, 'serving_policy_unavailable', 'Preview delivery policy unavailable')
  await enforceServingPolicy(c, preview.appId)
  const policy = requestServingPolicy(c)
  // Preview metadata currently uses the console database lane. Restricted
  // apps cannot enter that lane or emit an uncontrolled external download URL.
  if (policy && isRestrictedServingPolicy(policy))
    throw quickError(503, 'preview_unavailable', 'Preview unavailable with these update regions')
}

/** Clients must return to ingress after a preference change. Inner caches stay reusable. */
export function withFileServingHeaders(response: Response) {
  if (!servingRegionReaderEpoch)
    return response
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store, no-transform')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
