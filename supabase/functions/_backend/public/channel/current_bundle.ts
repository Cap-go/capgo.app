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
    .select('id, version')
    .eq('app_id', body.app_id)
    .eq('name', body.channel)
    .maybeSingle()

  if (channelError || !channelRow) {
    throw simpleError('cannot_find_channel', 'Cannot find channel', { supabaseError: channelError, app_id: body.app_id, channel: body.channel })
  }

  if (!(await checkPermission(c, 'channel.read', { appId: body.app_id, channelId: channelRow.id }))) {
    throw simpleError('cannot_access_channel', 'You can\'t access this channel', { app_id: body.app_id, channel: body.channel })
  }

  if (!channelRow.version) {
    throw simpleError('channel_has_no_bundle', 'Channel does not have a bundle linked', { app_id: body.app_id, channel: body.channel })
  }

  const { data: bundleRows, error: bundleError } = await supabase.rpc('get_channel_current_bundle_rbac', {
    p_app_id: body.app_id,
    p_channel_id: channelRow.id,
  })

  const bundleName = (bundleRows as Array<{ bundle_name: string | null }> | null)?.[0]?.bundle_name
  if (bundleError || !bundleName) {
    throw simpleError('cannot_find_bundle', 'Cannot find current bundle for channel', { supabaseError: bundleError, app_id: body.app_id, channel: body.channel })
  }

  return c.json({ bundle_name: bundleName })
}
