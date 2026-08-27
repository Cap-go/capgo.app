import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { BRES, createHono, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { version } from '../utils/version.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { supabaseApikey } from '../utils/supabase.ts'

interface FinishTusUploadBody {
  app_id: string
  name: string
  owner_org: string
}

function requireFinishTusUploadBody(body: unknown): FinishTusUploadBody | Response {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return quickError(400, 'invalid_json_body', 'Invalid JSON body', { body })

  const record = body as Record<string, unknown>
  const app_id = record.app_id
  const name = record.name
  const owner_org = record.owner_org

  if (typeof app_id !== 'string' || app_id.trim() === '')
    return quickError(400, 'error_app_id_missing', 'Error app_id missing', { body })
  if (typeof name !== 'string' || name.trim() === '')
    return quickError(400, 'error_bundle_name_missing', 'Error bundle name missing', { body })
  if (typeof owner_org !== 'string' || owner_org.trim() === '')
    return quickError(400, 'error_owner_org_missing', 'Error owner_org missing', { body })

  return { app_id, name, owner_org }
}

export const app = createHono('', version)

app.post('/', middlewareKey(), async (c) => {
  const parsedBody = requireFinishTusUploadBody(await parseBody<unknown>(c))
  if (parsedBody instanceof Response)
    return parsedBody
  const body = parsedBody
  const capgkey = c.get('capgkey') as string

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id })))
    return quickError(401, 'not_authorized', 'You cannot upload bundles for this app', { app_id: body.app_id })

  const { data: app, error: errorApp } = await supabaseApikey(c, capgkey)
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', body.app_id)
    .single()
  if (errorApp || !app)
    return quickError(404, 'app_not_found', 'Error App not found', { errorApp })

  if (app.owner_org !== body.owner_org)
    return quickError(400, 'owner_org_mismatch', 'Owner organization mismatch', { body })

  const filePath = `orgs/${body.owner_org}/apps/${body.app_id}/${body.name}.zip`

  const { data: version, error: errorVersion } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .select('id, storage_provider, deleted')
    .eq('name', body.name)
    .eq('app_id', body.app_id)
    .eq('deleted', false)
    .single()

  if (errorVersion || !version)
    return quickError(404, 'error_version_not_found', 'Error Version not found', { errorVersion })

  if (version.storage_provider !== 'r2-direct') {
    return quickError(400, 'error_version_not_uploadable', 'Version is not in an uploadable state', {
      storage_provider: version.storage_provider,
    })
  }

  const { error: changeError } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .update({ r2_path: filePath })
    .eq('id', version.id)

  if (changeError)
    throw simpleError('cannot_update_supabase', 'Cannot update bundle path after TUS upload', { changeError })

  cloudlog({ requestId: c.get('requestId'), message: 'finish_tus_upload', filePath, versionId: version.id })
  return c.json({ ...BRES, r2_path: filePath })
})
