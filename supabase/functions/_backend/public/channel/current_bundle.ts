import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

interface GetCurrentBundleBody {
  app_id: string
  channel: string
}

type ChannelVersionRow = {
  id: number
  name: string
  min_update_version: string | null
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

  const supabase = supabaseApikey(c, apikey.key)
  const { data: channelRow, error: channelError } = await supabase
    .from('channels')
    .select(`
      id,
      disable_auto_update,
      version:app_versions!channels_version_fkey(
        id,
        name,
        min_update_version,
        native_packages
      )
    `)
    .eq('app_id', body.app_id)
    .eq('name', body.channel)
    .maybeSingle()

  if (channelError || !channelRow) {
    throw simpleError('cannot_find_channel', 'Cannot find channel', { supabaseError: channelError, app_id: body.app_id, channel: body.channel })
  }

  if (!(await checkPermission(c, 'channel.read', { appId: body.app_id, channelId: channelRow.id }))) {
    throw simpleError('cannot_access_channel', 'You can\'t access this channel', { app_id: body.app_id, channel: body.channel })
  }

  const version = channelRow.version as ChannelVersionRow | null

  return c.json({
    bundle_name: version?.name ?? null,
    bundle_id: version?.id ?? null,
    min_update_version: version?.min_update_version ?? null,
    native_packages: version?.native_packages ?? [],
    disable_auto_update: channelRow.disable_auto_update,
  })
}
