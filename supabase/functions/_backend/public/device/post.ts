import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { DeviceLink } from './delete.ts'
import { syncLegacyChannelSelfOverrideForDevice } from '../../utils/channelSelfStore.ts'
import { BRES, quickError, simpleError } from '../../utils/hono.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { updateOrCreateChannelDevice } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

export async function post(c: Context<MiddlewareKeyVariables, any, object>, body: DeviceLink, apikey: Database['public']['Tables']['apikeys']['Row']) {
  if (!body.device_id || !body.app_id) {
    throw simpleError('missing_device_id_or_app_id', 'Missing device_id or app_id', { body })
  }

  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }

  if ((body as any).version_id) {
    throw simpleError('invalid_version_id', 'Cannot set version to device, use channel instead')
  }

  const effectiveApikey = apikey.key ?? (c.get('capgkey') as string)
  const principal = apikeyPrincipal(c, effectiveApikey)

  // if channel set channel_override to it
  if (body.channel) {
    // get channel by name through the caller's RBAC-visible scope
    let dataChannel: { id: number, public: boolean, owner_org: string } | null = null
    let dbError: unknown = null
    try {
      const rows = await withRlsContext(c, principal, client => queryJson<{ id: number, public: boolean, owner_org: string }>(
        client,
        'SELECT id, public, owner_org FROM public.channels WHERE app_id = $1 AND name = $2 LIMIT 2',
        [body.app_id, body.channel],
      ))
      dataChannel = rows.length === 1 ? rows[0] : null
    }
    catch (error) {
      dbError = error
    }
    if (dbError || !dataChannel) {
      throw quickError(404, 'channel_not_found', 'Cannot find channel', { dbError })
    }

    if (!(await checkPermission(c, 'channel.manage_forced_devices', { appId: body.app_id, channelId: dataChannel.id }))) {
      throw simpleError('cannot_access_channel', 'You can\'t manage forced devices for this channel', { app_id: body.app_id, channel: body.channel })
    }

    if (dataChannel.public) {
      throw simpleError('public_channel_override', 'Cannot set channel override for public channel')
    }
    const { error: channelDeviceError } = await updateOrCreateChannelDevice(c, {
      device_id: body.device_id,
      channel_id: dataChannel.id,
      app_id: body.app_id,
      owner_org: dataChannel.owner_org,
      // Public API override: never expires (only /channel_self rows are self-set).
      is_self_set: false,
    })
    if (channelDeviceError) {
      throw quickError(500, 'channel_device_error', 'Error setting channel override', { channelDeviceError })
    }
    if (!(await syncLegacyChannelSelfOverrideForDevice(c, principal, {
      device_id: body.device_id,
      channel_id: dataChannel.id,
      app_id: body.app_id,
    }))) {
      throw quickError(500, 'channel_self_store_error', 'Error syncing channel override store')
    }
    return c.json(BRES)
  }

  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.manage_devices', { appId: body.app_id }))) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id })
  }

  return c.json(BRES)
}
