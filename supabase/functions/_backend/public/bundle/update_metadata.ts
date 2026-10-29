import { BRES, getBodyOrQuery, honoFactory, simpleError } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { apikeyPrincipal, withRlsContext } from '../../utils/pg_rls.ts'
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

  const updateData: { link?: string, comment?: string } = {}

  if (body.link !== undefined) {
    updateData.link = body.link
  }

  if (body.comment !== undefined) {
    updateData.comment = body.comment
  }

  await withRlsContext(c, apikeyPrincipal(c, apikey.key), async (client) => {
    let versionFound = false
    try {
      const result = await client.query('SELECT id FROM public.app_versions WHERE app_id = $1 AND id = $2', [body.app_id, body.version_id])
      versionFound = result.rows.length === 1
    }
    catch (versionError) {
      throw simpleError('cannot_find_version', 'Cannot find version', { supabaseError: versionError })
    }
    if (!versionFound) {
      throw simpleError('cannot_find_version', 'Cannot find version', { supabaseError: null })
    }

    const columns = Object.keys(updateData) as (keyof typeof updateData)[]
    if (columns.length === 0) {
      throw simpleError('no_fields_to_update', 'No fields to update')
    }

    try {
      await client.query(
        `UPDATE public.app_versions SET ${columns.map((column, i) => `${column} = $${i + 3}`).join(', ')} WHERE app_id = $1 AND id = $2`,
        [body.app_id, body.version_id, ...columns.map(column => updateData[column])],
      )
    }
    catch (updateError) {
      throw simpleError('cannot_update_version_metadata', 'Cannot update version metadata', { supabaseError: updateError })
    }
  })

  return c.json(BRES)
})
