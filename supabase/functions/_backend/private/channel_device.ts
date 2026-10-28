import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { syncLegacyChannelSelfOverrideDeleteForDevice, syncLegacyChannelSelfOverrideForDevice } from '../utils/channelSelfStore.ts'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../utils/pg_rls.ts'
import { checkPermission } from '../utils/rbac.ts'
import { isValidAppId } from '../utils/utils.ts'

const setBodySchema = z.object({
  app_id: z.string(),
  device_id: z.uuid(),
  channel_id: z.number().int().min(1),
})

const deleteBodySchema = z.object({
  app_id: z.string(),
  device_id: z.uuid(),
})

interface SetChannelDeviceBody {
  app_id: string
  device_id: string
  channel_id: number
}

interface DeleteChannelDeviceBody {
  app_id: string
  device_id: string
}

type ChannelRow = Pick<Database['public']['Tables']['channels']['Row'], 'id' | 'app_id' | 'owner_org' | 'public'>
type ChannelDeviceRow = Pick<Database['public']['Tables']['channel_devices']['Row'], 'app_id' | 'channel_id' | 'owner_org'>

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

function requireAuth(c: Context<MiddlewareKeyVariables>): AuthInfo {
  const auth = c.get('auth')
  if (!auth) {
    quickError(401, 'not_authorized', 'Not authorized')
  }
  return auth
}

function assertValidAppId(appId: string) {
  if (!isValidAppId(appId)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
  }
}

async function requireManageDevices(c: Context<MiddlewareKeyVariables>, appId: string) {
  assertValidAppId(appId)

  if (!(await checkPermission(c, 'app.manage_devices', { appId }))) {
    quickError(403, 'permission_denied', 'Permission denied: app.manage_devices', { appId })
  }
}

async function requireManageForcedDevices(c: Context<MiddlewareKeyVariables>, appId: string, channelId: number) {
  assertValidAppId(appId)

  if (!(await checkPermission(c, 'channel.manage_forced_devices', { appId, channelId }))) {
    quickError(403, 'permission_denied', 'Permission denied: channel.manage_forced_devices', { appId, channelId })
  }
}

async function getWritableChannel(c: Context<MiddlewareKeyVariables>, body: SetChannelDeviceBody): Promise<ChannelRow> {
  assertValidAppId(body.app_id)

  let channel: ChannelRow | null = null
  let error: unknown = null
  try {
    channel = await withRlsContext(c, authPrincipal(c, requireAuth(c)), client => queryJsonOne<ChannelRow>(
      client,
      'SELECT id, app_id, owner_org, public FROM public.channels WHERE app_id = $1 AND id = $2',
      [body.app_id, body.channel_id],
    ))
  }
  catch (channelError) {
    error = channelError
  }

  if (error || !channel) {
    quickError(404, 'channel_not_found', 'Cannot find channel', { appId: body.app_id, channelId: body.channel_id, error })
  }

  if (channel.public) {
    throw simpleError('public_channel_override', 'Cannot set channel override for public channel')
  }

  return channel
}

async function getExistingChannelDeviceOverride(c: Context<MiddlewareKeyVariables>, body: DeleteChannelDeviceBody): Promise<ChannelDeviceRow | null> {
  assertValidAppId(body.app_id)

  try {
    return await withRlsContext(c, authPrincipal(c, requireAuth(c)), client => queryJsonOne<ChannelDeviceRow>(
      client,
      'SELECT app_id, channel_id, owner_org FROM public.channel_devices WHERE device_id = $1 AND app_id = $2',
      [body.device_id.toLowerCase(), body.app_id],
    ))
  }
  catch (error) {
    quickError(500, 'channel_device_error', 'Error loading channel override', { error })
  }
}

export async function setChannelDeviceOverride(c: Context<MiddlewareKeyVariables>, body: SetChannelDeviceBody) {
  const channel = await getWritableChannel(c, body)
  await requireManageForcedDevices(c, channel.app_id, channel.id)

  const override = {
    app_id: body.app_id,
    channel_id: channel.id,
    device_id: body.device_id.toLowerCase(),
    owner_org: channel.owner_org,
    // Console override: never expires (only /channel_self rows are self-set).
    is_self_set: false,
  }

  try {
    await withRlsContext(c, authPrincipal(c, requireAuth(c)), client => client.query(
      `INSERT INTO public.channel_devices (app_id, channel_id, device_id, owner_org, is_self_set)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (app_id, device_id) DO UPDATE SET
        app_id = EXCLUDED.app_id,
        channel_id = EXCLUDED.channel_id,
        device_id = EXCLUDED.device_id,
        owner_org = EXCLUDED.owner_org,
        is_self_set = EXCLUDED.is_self_set`,
      [override.app_id, override.channel_id, override.device_id, override.owner_org, override.is_self_set],
    ))
  }
  catch (error) {
    quickError(500, 'channel_device_error', 'Error setting channel override', { error })
  }

  if (!(await syncLegacyChannelSelfOverrideForDevice(c, authPrincipal(c, requireAuth(c)), override))) {
    quickError(500, 'channel_self_store_error', 'Error syncing channel override store')
  }

  return c.json(BRES)
}

export async function deleteChannelDeviceOverride(c: Context<MiddlewareKeyVariables>, body: DeleteChannelDeviceBody) {
  const existingOverride = await getExistingChannelDeviceOverride(c, body)
  if (existingOverride)
    await requireManageForcedDevices(c, existingOverride.app_id, existingOverride.channel_id)
  else
    await requireManageDevices(c, body.app_id)

  try {
    await withRlsContext(c, authPrincipal(c, requireAuth(c)), client => client.query(
      'DELETE FROM public.channel_devices WHERE device_id = $1 AND app_id = $2',
      [body.device_id.toLowerCase(), body.app_id],
    ))
  }
  catch (error) {
    quickError(500, 'channel_device_error', 'Error deleting channel override', { error })
  }

  if (!(await syncLegacyChannelSelfOverrideDeleteForDevice(c, authPrincipal(c, requireAuth(c)), body.app_id, body.device_id))) {
    quickError(500, 'channel_self_store_error', 'Error syncing channel override store')
  }

  return c.json(BRES)
}

app.post('/', middlewareAuth(), async (c) => {
  const body = await parseBody<SetChannelDeviceBody>(c)
  const parsedBodyResult = safeParseSchema(setBodySchema, body)
  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid JSON body', { body, parsedBodyResult })
  }

  return setChannelDeviceOverride(c, parsedBodyResult.data)
})

app.delete('/', middlewareAuth(), async (c) => {
  const body = await parseBody<DeleteChannelDeviceBody>(c)
  const parsedBodyResult = safeParseSchema(deleteBodySchema, body)
  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid JSON body', { body, parsedBodyResult })
  }

  return deleteChannelDeviceOverride(c, parsedBodyResult.data)
})
