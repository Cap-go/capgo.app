import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { AppInfos } from '../utils/types.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, simpleRateLimit } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getManifestDownloadSize, parseManifestSizeVersionId } from '../utils/manifest_size.ts'
import { parsePluginBody } from '../utils/plugin_parser.ts'
import { updateRequestSchema } from '../utils/plugin_validation.ts'
import { update } from '../utils/update.ts'

import {
  isLimited,
} from '../utils/utils.ts'

// Plugin endpoints are intentionally public device endpoints: their responses are
// considered public data, so we do not require Capgo JWT/API-key auth or add
// checks beyond Supabase/platform protections. Endpoint-specific validation, plan
// checks, and rate limits still apply.
export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', async (c) => {
  const body = await parseBody<AppInfos>(c)
  // Curated fields only — full body serialization was a top CPU cost on HAR inspect.
  cloudlog({
    requestId: c.get('requestId'),
    message: 'post updates body',
    app_id: body.app_id,
    device_id: body.device_id,
    version_name: body.version_name,
    version_build: body.version_build,
    platform: body.platform,
    plugin_version: body.plugin_version,
  })
  if (isLimited(c, body.app_id)) {
    // Pass curated metadata only — see simpleRateLimit contract in hono.ts.
    // Reflecting the raw `body` would echo the client's full update payload
    // back inside the 429 response's `moreInfo`.
    return simpleRateLimit({ app_id: body.app_id })
  }
  return update(c, parsePluginBody<AppInfos>(c, body, updateRequestSchema))
})

app.post('/manifest_size', async (c) => {
  const body = await parseBody<AppInfos & {
    manifest?: unknown
    files?: unknown
    version?: string
    version_id?: unknown
  }>(c)
  const files = body.manifest ?? body.files
  cloudlog({
    requestId: c.get('requestId'),
    message: 'post updates manifest_size body',
    app_id: body.app_id,
    device_id: body.device_id,
    version: body.version,
    version_id: body.version_id,
    files_count: Array.isArray(files) ? files.length : 0,
  })
  if (isLimited(c, body.app_id))
    return simpleRateLimit({ app_id: body.app_id })

  const parsedBody = parsePluginBody<AppInfos>(c, body, updateRequestSchema)
  const size = await getManifestDownloadSize(c, parsedBody.app_id, typeof body.version === 'string' ? body.version : undefined, parseManifestSizeVersionId(body.version_id), files)
  return c.json(size)
})

app.get('/', (c) => {
  return c.json(BRES)
})
