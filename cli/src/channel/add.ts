import type { ChannelAddOptions } from '../schemas/channel'
import { intro, log, outro } from '@clack/prompts'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { createChannel } from '../api/channels'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getConfig,
  getOrganizationId,
  resolveUserIdFromApiKey,
  sendEvent,
} from '../utils'

export async function addChannelInternal(channelId: string, appId: string, options: ChannelAddOptions, silent = false) {
  if (!silent)
    intro('Create channel')

  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig(silent).catch(() => undefined)
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new Error('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon, silent)
  await check2FAComplianceForApp(supabase, appId, silent)
  // TODO(cli-http): identity still uses rpc(get_user_id) via resolveUserIdFromApiKey
  await resolveUserIdFromApiKey(supabase, options.apikey)
  // Creating a channel needs the exact RBAC permission. The backend and channels
  // INSERT RLS remain authoritative, so a key without app.create_channel is denied.
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.create_channel', silent, true)

  if (!silent)
    log.info(`Creating channel ${appId}#${channelId} to Capgo`)

  const orgId = await getOrganizationId(options.apikey!, appId, { supaHost: options.supaHost, supaAnon: options.supaAnon })
  const res = await createChannel({
    apikey: options.apikey!,
    silent,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  }, {
    channel: channelId,
    app_id: appId,
    version: null,
    allow_device_self_set: options.selfAssign ?? false,
    public: options.default ?? false,
  })

  if (res.error) {
    if (!silent)
      log.error(`Cannot create Channel 🙀\n${formatError(res.error)}`)
    throw new Error(`Cannot create channel: ${formatError(res.error)}`)
  }

  await sendEvent(options.apikey, {
    channel: 'channel',
    event: 'Create channel',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appId,
      'channel': channelId,
    },
  }).catch(() => {})

  if (!silent) {
    log.success('Channel created ✅')
    outro('Done ✅')
  }

  // POST /channel returns { status: 'ok' } when creating without a bundle promote;
  // keep the previous PostgREST shape so callers can read the channel name.
  const data = res.data && typeof res.data === 'object' ? res.data as Record<string, unknown> : {}
  return { ...data, name: channelId }
}

export async function addChannel(channelId: string, appId: string, options: ChannelAddOptions) {
  await addChannelInternal(channelId, appId, options, false)
}
