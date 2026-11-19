import type { Database } from '../../utils/supabase.types.ts'
import type { AiBumpLevelBody } from './ai_bump_level.ts'
import type { GetLatest } from './get.ts'
import type { UpsertBundleBody } from './upsert.ts'
import { bodyLimit } from 'hono/body-limit'
import { recommendRelease } from './recommend.ts'
import { recordCicdDeploy } from '../../utils/cicdDetection.ts'
import { getBodyOrQuery, honoFactory, quickError } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { aiBumpLevel } from './ai_bump_level.ts'
import { cleanupBundles } from './cleanup.ts'
import { createBundle } from './create.ts'
import { deleteBundle } from './delete.ts'
import { get } from './get.ts'
import { setChannel } from './set_channel.ts'
import { upsertBundle } from './upsert.ts'
import { app as updateMetadataApp } from './update_metadata.ts'
import { abortBundleUpload, completeBundleUpload, prepareBundleUpload } from './upload_session.ts'

export const app = honoFactory.createApp()
// Bundle writes authenticate through the primary connection so a just-created key is visible.
const writeBundleMiddleware = middlewareKey({ usePostgres: true, readOnly: false })

// Add the route for updating bundle metadata
app.route('/metadata', updateMetadataApp)

app.get('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<GetLatest>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return get(c, body, apikey)
})

app.delete('/', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<GetLatest>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return deleteBundle(c, body, apikey)
})

app.put('/', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return setChannel(c, body, apikey)
})

app.post('/', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const response = await createBundle(c, body, apikey)
  if (response.ok)
    await recordCicdDeploy(c, { appId: body?.app_id, product: 'ota', apikeyRbacId: apikey?.rbac_id })
  return response
})

app.post('/upsert', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<UpsertBundleBody>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const response = await upsertBundle(c, body, apikey)
  // The CLI sets storage_provider only after the zip and manifest uploads finish.
  // Initial metadata creation and the intermediate TUS r2_path update are not deployments.
  if (response.ok && (body.storage_provider === 'r2' || (body.storage_provider === 'external' && body.external_url)))
    await recordCicdDeploy(c, { appId: body?.app_id, product: 'ota', apikeyRbacId: apikey?.rbac_id })
  return response
})

// Server-side `bundle cleanup`: picks and soft-deletes old bundles in one request.
app.post('/cleanup', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<unknown>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return cleanupBundles(c, body, apikey)
})

// Presigned upload sessions (hosted MCP): prepare -> PUT zip -> complete, server-side CLI parity.
app.post('/upload/prepare', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<unknown>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return prepareBundleUpload(c, body, apikey)
})

app.post('/upload/complete', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<unknown>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return completeBundleUpload(c, body, apikey)
})

app.post('/upload/abort', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<unknown>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return abortBundleUpload(c, body, apikey)
})

app.post('/ai_bump_level', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<AiBumpLevelBody>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return aiBumpLevel(c, body, apikey)
})

app.post('/recommend', bodyLimit({ maxSize: 64 * 1024, onError: () => quickError(413, 'request_too_large', 'Release context exceeds 64 KiB') }), writeBundleMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null)
  const apikey = c.get('apikey')
  if (!apikey)
    throw quickError(401, 'not_authorized', 'API key required')
  return recommendRelease(c, body, apikey)
})
