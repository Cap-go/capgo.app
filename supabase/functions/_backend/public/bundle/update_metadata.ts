import { BRES, getBodyOrQuery, honoFactory, simpleError } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

export const app = honoFactory.createApp()

interface UpdateMetadataBody {
  app_id: string
  version_id: number
  link?: string
  comment?: string
}

app.post('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<UpdateMetadataBody>(c)
  const apikey = c.get('apikey')!

  if (!body.app_id || !body.version_id) {
    throw simpleError('missing_required_fields', 'Missing required fields', { app_id: body.app_id, version_id: body.version_id })
  }

  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id }))) {
    throw simpleError('cannot_update_bundle_metadata', 'You can\'t update metadata for this app', { app_id: body.app_id })
  }

  const { data: version, error: versionError } = await supabaseApikey(c, apikey.key)
    .from('app_versions')
    .select('*')
    .eq('app_id', body.app_id)
    .eq('id', body.version_id)
    .single()

  if (versionError || !version) {
    throw simpleError('cannot_find_version', 'Cannot find version', { supabaseError: versionError })
  }

  const updateData: any = {}

  if (body.link !== undefined) {
    updateData.link = body.link
  }

  if (body.comment !== undefined) {
    updateData.comment = body.comment
  }

  if (Object.keys(updateData).length === 0) {
    throw simpleError('no_fields_to_update', 'No fields to update')
  }

  const { error: updateError } = await supabaseApikey(c, apikey.key)
    .from('app_versions')
    .update(updateData)
    .eq('app_id', body.app_id)
    .eq('id', body.version_id)

  if (updateError) {
    throw simpleError('cannot_update_version_metadata', 'Cannot update version metadata', { supabaseError: updateError })
  }

  return c.json(BRES)
})
