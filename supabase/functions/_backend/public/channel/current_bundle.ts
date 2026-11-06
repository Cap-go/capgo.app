import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { apikeyPrincipal, queryJson, queryJsonOne, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { isValidAppId } from '../../utils/utils.ts'

interface GetCurrentBundleBody {
  app_id: string
  channel: string
}

interface ChannelRow {
  id: number
  disable_auto_update: Database['public']['Enums']['disable_update']
  version: number | null
}

type ChannelVersionRow = {
  id: number
  name: string
  min_update_version: string | null
  checksum: string | null
  deleted: boolean
  native_packages: Database['public']['Tables']['app_versions']['Row']['native_packages']
}

export async function getCurrentBundle(
  c: Context<MiddlewareKeyVariables>,
  body: GetCurrentBundleBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  if (!body.channel) {
    throw simpleError('missing_channel', 'Missing channel', { body })
  }

  const principal = apikeyPrincipal(c, apikey.key)
  let channelRow: ChannelRow | null = null
  let channelError: unknown = null
  try {
    const channelRows = await withRlsContext(c, principal, client => queryJson<ChannelRow>(
      client,
      'SELECT id, disable_auto_update, version FROM public.channels WHERE app_id = $1 AND name = $2 LIMIT 2',
      [body.app_id, body.channel],
    ))
    // maybeSingle(): more than one match was an error, not a pick.
    if (channelRows.length > 1)
      channelError = { message: 'multiple channels match' }
    else
      channelRow = channelRows[0] ?? null
  }
  catch (error) {
    channelError = error
  }

  if (channelError || !channelRow) {
    throw simpleError('cannot_find_channel', 'Cannot find channel', { supabaseError: channelError, app_id: body.app_id, channel: body.channel })
  }

  if (!(await checkPermission(c, 'channel.read', { appId: body.app_id, channelId: channelRow.id }))) {
    throw simpleError('cannot_access_channel', 'You can\'t access this channel', { app_id: body.app_id, channel: body.channel })
  }

  // The app_versions embed would be filtered by app_versions RLS (app.read_bundles),
  // so channel.read-only callers would get a null bundle. channel.read was verified
  // above; load the linked version on the service connection scoped to this app.
  let version: ChannelVersionRow | null = null
  if (channelRow.version !== null && channelRow.version !== undefined) {
    const pg = await getPgClient(c)
    try {
      version = await queryJsonOne<ChannelVersionRow>(
        pg,
        'SELECT id, name, min_update_version, checksum, deleted, native_packages FROM public.app_versions WHERE app_id = $1 AND id = $2',
        [body.app_id, channelRow.version],
      )
    }
    catch (versionError) {
      throw simpleError('cannot_find_bundle', 'Cannot load channel bundle', { supabaseError: versionError, app_id: body.app_id, channel: body.channel })
    }
    finally {
      closeClient(c, pg)
    }
  }

  return c.json({
    bundle_name: version?.name ?? null,
    bundle_id: version?.id ?? null,
    min_update_version: version?.min_update_version ?? null,
    // Lets `bundle upload` compare checksums without a second bundle lookup per channel.
    checksum: version && !version.deleted ? version.checksum : null,
    native_packages: version?.native_packages ?? [],
    disable_auto_update: channelRow.disable_auto_update,
  })
}
