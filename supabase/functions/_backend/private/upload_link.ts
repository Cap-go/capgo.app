import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { s3 } from '../utils/s3.ts'
import { supabaseApikey } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'

interface DataUpload {
  name: string
  app_id: string
  version?: number
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareKey(), async (c) => {
  const body = await parseBody<DataUpload>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post upload link body', body })
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const capgkey = c.get('capgkey') as string
  cloudlog({
    requestId: c.get('requestId'),
    message: 'apikey context',
    apikeyId: apikey.id,
    userId: apikey.user_id,
  })
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id }))) {
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.app_id })
  }

  const { data: app, error: errorApp } = await supabaseApikey(c, capgkey)
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', body.app_id)
    // .eq('user_id', userId)
    .single()
  if (errorApp) {
    return quickError(404, 'error_app_not_found', 'Error App not found', { errorApp })
  }

  const { data: version, error: errorVersion } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .select('id, name')
    .eq('name', body.name)
    .eq('app_id', body.app_id)
    .eq('storage_provider', 'r2-direct')
    .eq('user_id', apikey.user_id)
    .single()
  if (errorVersion) {
    return quickError(404, 'error_version_not_found', 'Error App or Version not found', { errorVersion })
  }

  // orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/ee.forgr.capacitor_go/11.zip
  const filePath = `orgs/${app.owner_org}/apps/${app.app_id}/${version.name}.zip`
  cloudlog({ requestId: c.get('requestId'), message: 'filePath', filePath })
  // check if app version exist

  cloudlog({ requestId: c.get('requestId'), message: 's3.checkIfExist', filePath })

  // check if object exist in r2
  const exist = await s3.checkIfExist(c, filePath)
  if (exist) {
    throw simpleError('error_already_exist', 'Error already exist', { exist })
  }

  const url = await s3.getUploadUrl(c, filePath)
  if (!url) {
    throw simpleError('cannot_get_upload_link', 'Cannot get upload link')
  }

  await sendEventToTracking(c, {
    channel: 'upload-get-link',
    event: 'Upload via single file',
    icon: '🏛️',
    user_id: app.owner_org,
    groups: { organization: app.owner_org },
    notify: false,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'upload link generated', filePath })
  const response = { url }

  const { error: changeError } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .update({ r2_path: filePath })
    .eq('id', version.id)

  if (changeError) {
    throw simpleError('cannot_update_supabase', 'Cannot update supabase', { changeError })
  }

  return c.json(response)
})
