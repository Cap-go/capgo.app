import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelAddOptions } from '../schemas/channel'
import type { Database } from '../types/supabase.types'
import { intro, log, outro } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { createChannel, findChannel } from '../api/channels'
import { isChannelAlreadyExistsError } from '../init/channel-conflict'
import {
  createSupabaseClient,
  findSavedKey,
  formatCapgoCliInvokeError,
  formatError,
  getAppId,
  getConfig,
  getOrganizationId,
  resolveUserIdFromApiKey,
  sendEvent,
} from '../utils'

export async function isChannelReadableByCaller(
  supabase: SupabaseClient<Database>,
  appId: string,
  channelName: string,
): Promise<boolean | null> {
  const { data, error } = await findChannel(supabase, appId, channelName)
  if (!error && data)
    return true

  const code = (error as { code?: string } | null)?.code
  if (code === 'PGRST116')
    return false

  return null
}

export type ChannelAddDuplicateOutcome = 'duplicate_readable' | 'duplicate_inaccessible' | 'not_duplicate'

export async function resolveChannelAddDuplicateOutcome(
  params: {
    createError: unknown
    supabase: SupabaseClient<Database>
    appId: string
    channelName: string
  },
  deps: {
    isChannelReadableByCaller?: typeof isChannelReadableByCaller
  } = {},
): Promise<ChannelAddDuplicateOutcome> {
  if (!isChannelAlreadyExistsError(params.createError))
    return 'not_duplicate'

  const readable = await (deps.isChannelReadableByCaller ?? isChannelReadableByCaller)(
    params.supabase,
    params.appId,
    params.channelName,
  )

  if (readable === true)
    return 'duplicate_readable'
  if (readable === false)
    return 'duplicate_inaccessible'

  throw new Error('Cannot verify channel access for this API key. Grant app.read_channels or channel.read, then retry.')
}

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
    const createErrorDetail = await formatCapgoCliInvokeError(res.error)
    let duplicateOutcome: ChannelAddDuplicateOutcome
    try {
      duplicateOutcome = await resolveChannelAddDuplicateOutcome({
        createError: createErrorDetail,
        supabase,
        appId,
        channelName: channelId,
      })
    }
    catch (ownershipError) {
      const message = formatError(ownershipError)
      if (!silent)
        log.error(`Cannot create Channel 🙀\n${message}`)
      throw new Error(`Cannot create channel: ${message}`)
    }

    if (duplicateOutcome === 'duplicate_readable') {
      void trackEvent({
        channel: 'channel',
        event: 'CLI Recovered Channel Already Exists',
        appId,
        apikey: options.apikey!,
        orgId,
        tags: { channel: channelId },
      })

      if (!silent) {
        log.success(`Channel ${channelId} already exists ✅`)
        outro('Done ✅')
      }

      return { name: channelId }
    }

    if (duplicateOutcome === 'duplicate_inaccessible') {
      const message = `Channel ${channelId} already exists but is not accessible with this API key`
      if (!silent)
        log.error(`Cannot create Channel 🙀\n${message}`)
      throw new Error(`Cannot create channel: ${message}`)
    }

    const message = createErrorDetail
    if (!silent)
      log.error(`Cannot create Channel 🙀\n${message}`)
    throw new Error(`Cannot create channel: ${message}`)
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
