import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { getPath, s3 } from '../utils/s3.ts'

export const app = new Hono<MiddlewareKeyVariables>()
app.post('/', middlewareAPISecret, async (c) => {
  // unsafe parse the body
  const body = await parseBody<{ version: Database['public']['Tables']['app_versions']['Row'] }>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post body cron_clear_versions', body })

  const version = body.version
  if (!version)
    throw simpleError('no_version', 'No version', { body })

  // Let's start with the metadata
  const pg = await getPgClient(c)
  try {
    return await clearVersion(c, pg, version)
  }
  finally {
    closeClient(c, pg)
  }
})

async function clearVersion(c: Context<MiddlewareKeyVariables>, pg: PgClient, version: Database['public']['Tables']['app_versions']['Row']) {
  let ownerOrg = version.owner_org ?? null
  const isUserIdMissing = version.user_id == null
  if (isUserIdMissing || ownerOrg == null) {
    // find user_id and owner_org from the app_id
    let app: { user_id: string, owner_org: string }
    try {
      const result = await pg.query<{ user_id: string, owner_org: string }>(
        'SELECT user_id, owner_org FROM public.apps WHERE app_id = $1 LIMIT 2',
        [version.app_id],
      )
      if (result.rows.length !== 1)
        throw new Error(`Expected 1 app row, got ${result.rows.length}`)
      app = result.rows[0]
    }
    catch (errorApp) {
      throw simpleError('cannot_find_app_data', 'Cannot find app data for app_id', { error: errorApp, app_id: version.app_id })
    }
    version.user_id ??= app.user_id
    ownerOrg ??= app.owner_org ?? null
  }

  if (ownerOrg == null) {
    throw simpleError('cannot_find_owner_org', 'Cannot find owner_org for app_id', { app_id: version.app_id })
  }

  let notFound = false
  try {
    const v2Path = await getPath(c, version)
      .catch((e) => {
        cloudlog({ requestId: c.get('requestId'), message: 'error getPath', error: e })
        // if error is rate limit this terminate the function
        if (e.message.includes('Rate limit exceeded')) {
          return quickError(429, 'rate_limit_exceeded', 'Rate limit exceeded')
        }
        return null
      })
    cloudlog({ requestId: c.get('requestId'), message: 'v2Path', v2Path })
    if (!v2Path) {
      notFound = true
      return quickError(404, 'no_path', 'No path', { versionId: version.id })
    }
    const size = await s3.getSize(c, v2Path).catch((e) => {
      cloudlog({ requestId: c.get('requestId'), message: 'error getSize', error: e })
      // if error is rate limit this terminate the function
      if (e.message.includes('Rate limit exceeded')) {
        return quickError(429, 'rate_limit_exceeded', 'Rate limit exceeded')
      }
      return null
    })
    if (!size) {
      cloudlog({ requestId: c.get('requestId'), message: `No size for ${v2Path}, ${size}` })
      // throw error to trigger the deletion
      notFound = true
      throw simpleError('no_size', 'No size', { versionId: version.id, v2Path })
    }
    // get checksum from table app_versions
    let appVersion: { checksum: string | null }
    try {
      const result = await pg.query<{ checksum: string | null }>(
        'SELECT checksum FROM public.app_versions WHERE id = $1',
        [version.id],
      )
      if (result.rows.length !== 1)
        throw new Error(`Expected 1 app_versions row, got ${result.rows.length}`)
      appVersion = result.rows[0]
    }
    catch (errorAppVersion) {
      throw simpleError('cannot_find_checksum', 'Cannot find checksum for app_versions id', { error: errorAppVersion })
    }
    const checksum = appVersion.checksum
    if (!checksum) {
      cloudlog({ requestId: c.get('requestId'), message: `No checksum for ${v2Path}, ${checksum}` })
    }

    cloudlog({ requestId: c.get('requestId'), message: `Upsert app_versions_meta (version id: ${version.id}) to: ${size}` })

    await pg.query(
      `INSERT INTO public.app_versions_meta (id, app_id, checksum, size, owner_org)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        app_id = EXCLUDED.app_id,
        checksum = EXCLUDED.checksum,
        size = EXCLUDED.size,
        owner_org = EXCLUDED.owner_org`,
      [version.id, version.app_id, checksum ?? '', size, ownerOrg],
    ).catch((error: unknown) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot upsert app_versions_meta', versionId: version.id, error })
    })
  }
  catch (errorSize) {
    if (errorSize instanceof Error && errorSize.message.includes('Rate limit exceeded')) {
      cloudlog({ requestId: c.get('requestId'), message: 'Rate limit exceeded', error: errorSize })
      return c.json({ status: 'Rate limit exceeded' }, 429)
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'errorSize', notFound, error: errorSize })
    // Ensure that the version is not linked anywhere
    let linkedChannels: { id: string }[]
    try {
      const result = await pg.query<{ id: string }>('SELECT id FROM public.channels WHERE version = $1', [version.id])
      linkedChannels = result.rows
    }
    catch (error) {
      throw simpleError('cannot_check_channel_count', 'Cannot check channel count', { error })
    }

    if (linkedChannels.length > 0) {
      if (notFound) {
        await pg.query('UPDATE public.channels SET version = NULL WHERE version = $1', [version.id])
          .catch((error: unknown) => {
            cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot unlink version from channels', versionId: version.id, error })
          })
      }
      else {
        throw simpleError('cannot_delete_failed_version', 'Cannot delete failed version', { error: `linked in some channels (${linkedChannels.map(d => d.id).join(', ')})` })
      }
    }

    try {
      await pg.query('DELETE FROM public.app_versions WHERE id = $1', [version.id])
    }
    catch (error1) {
      throw simpleError('cannot_delete_version', 'Cannot delete version', { error: error1 })
    }
  }
  return c.json(BRES)
}
