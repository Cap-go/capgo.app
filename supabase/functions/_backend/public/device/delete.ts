import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { syncLegacyChannelSelfOverrideDeleteForDevice } from '../../utils/channelSelfStore.ts'
import { BRES, quickError, simpleError } from '../../utils/hono.ts'
import { apikeyPrincipal, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { isValidAppId } from '../../utils/utils.ts'

export interface DeviceLink {
  app_id: string
  device_id: string
  channel?: string
}

export async function deleteOverride(c: Context, body: DeviceLink, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!body.device_id) {
    throw simpleError('missing_device_id', 'Missing device_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.manage_devices', { appId: body.app_id }))) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id })
  }

  const principal = apikeyPrincipal(c, apikey.key)
  try {
    await withRlsContext(c, principal, client => client.query(
      'DELETE FROM public.channel_devices WHERE app_id = $1 AND device_id = $2',
      [body.app_id, body.device_id],
    ))
  }
  catch {
    throw simpleError('invalid_app_id', 'You can\'t access this app', { app_id: body.app_id })
  }
  if (!(await syncLegacyChannelSelfOverrideDeleteForDevice(c, principal, body.app_id, body.device_id))) {
    throw quickError(500, 'channel_self_store_error', 'Error syncing channel override store', { app_id: body.app_id, device_id: body.device_id })
  }
  return c.json(BRES)
}
