import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { confirm as confirmC, intro, log, outro, spinner } from '@clack/prompts'
import { Table } from '@sauber/table'
import { formatError, getCapgoCliHttpStatus, invokeCapgoCliApi } from '../utils'

interface CheckVersionOptions {
  silent?: boolean
  autoUnlink?: boolean
  channelName?: string
  requireMatch?: boolean
  apikey?: string
  supaHost?: string
  supaAnon?: string
}

interface CapgoHttpOptions {
  apikey: string
  silent?: boolean
  supaHost?: string
  supaAnon?: string
}

type HttpChannel = {
  id: number
  name: string
  public?: boolean
  ios?: boolean
  android?: boolean
  allow_device_self_set?: boolean
  allow_emulator?: boolean
  allow_device?: boolean
  allow_dev?: boolean
  allow_prod?: boolean
  disableAutoUpdate?: string
  disable_auto_update?: string
  disableAutoUpdateUnderNative?: boolean
  disable_auto_update_under_native?: boolean
  created_at?: string
  created_by?: string
  app_id?: string
  version?: { id?: number, name?: string } | null
  rollout_version?: number | null
  rollout_version_info?: { id?: number, name?: string } | null
}

function normalizeHttpChannel(row: HttpChannel): Channel {
  return {
    id: row.id,
    name: row.name,
    public: !!row.public,
    // TODO(cli-http): GET channel does not currently return ios/android; default false for display
    ios: row.ios ?? false,
    android: row.android ?? false,
    disable_auto_update: String(row.disableAutoUpdate ?? row.disable_auto_update ?? ''),
    disable_auto_update_under_native: !!(row.disableAutoUpdateUnderNative ?? row.disable_auto_update_under_native),
    allow_device_self_set: !!row.allow_device_self_set,
    allow_emulator: !!row.allow_emulator,
    allow_device: !!row.allow_device,
    allow_dev: !!row.allow_dev,
    allow_prod: !!row.allow_prod,
    version: row.version ?? undefined,
  }
}

async function fetchChannelsPage(appid: string, page: number, options: CapgoHttpOptions, channel?: string) {
  const params = new URLSearchParams({ app_id: appid, page: String(page) })
  if (channel)
    params.set('channel', channel)
  return invokeCapgoCliApi<HttpChannel | HttpChannel[]>(`channel?${params.toString()}`, {
    apikey: options.apikey,
    method: 'GET',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
}

export async function checkVersionNotUsedInChannel(
  _supabase: SupabaseClient<Database>,
  appid: string,
  versionData: Database['public']['Tables']['app_versions']['Row'],
  options: CheckVersionOptions = {},
) {
  const { silent = false, autoUnlink = false, channelName, requireMatch = false, apikey, supaHost, supaAnon } = options
  if (!apikey) {
    // TODO(cli-http): callers must pass apikey for HTTP channel lookups
    throw new Error('Missing API key for channel version check')
  }

  const channels: HttpChannel[] = []
  let page = 0
  while (true) {
    const { data, error } = await fetchChannelsPage(appid, page, { apikey, silent, supaHost, supaAnon }, channelName)
    if (error) {
      if (channelName && getCapgoCliHttpStatus(error) === 400) {
        break
      }
      if (!silent)
        log.error(`Cannot check Version ${appid}@${versionData.name}: ${formatError(error)}`)
      throw new Error(`Cannot check version ${appid}@${versionData.name}: ${formatError(error)}`)
    }
    if (channelName) {
      if (data && !Array.isArray(data))
        channels.push(data)
      break
    }
    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    channels.push(...batch)
    if (batch.length < 50)
      break
    page += 1
  }

  const channelFound = channels.filter((channel) => {
    const versionId = channel.version?.id
    const rolloutId = channel.rollout_version ?? channel.rollout_version_info?.id
    return versionId === versionData.id || rolloutId === versionData.id
  })

  if (!channelFound.length) {
    if (channelName && requireMatch) {
      const message = `Version ${appid}@${versionData.name} is not linked to channel ${channelName}`
      if (!silent)
        log.error(message)
      throw new Error(message)
    }
    return
  }

  if (silent && !autoUnlink)
    throw new Error(`Version ${appid}@${versionData.name} is used in ${channelFound.length} channel(s)`) // No interactivity allowed

  if (!silent)
    intro(`❌ Version ${appid}@${versionData.name} is used in ${channelFound.length} channel${channelFound.length > 1 ? 's' : ''}`)

  let shouldUnlink = autoUnlink
  if (!autoUnlink) {
    const response = await confirmC({ message: 'unlink it?' })
    shouldUnlink = response === true
  }

  if (!shouldUnlink) {
    log.error('Unlink it first')
    throw new Error(`Version ${appid}@${versionData.name} is still linked to channel(s)`) // Stop command
  }

  for (const channel of channelFound) {
    const s = silent ? null : spinner()
    s?.start(`Unlinking channel ${channel.name}`)

    const body: Record<string, unknown> = {
      app_id: appid,
      channel: channel.name,
    }
    if (channel.version?.id === versionData.id)
      body.version = null
    if ((channel.rollout_version ?? channel.rollout_version_info?.id) === versionData.id) {
      body.rollout_version = null
      body.rollout_enabled = false
      body.rollout_percentage_bps = 0
      body.rollout_paused_at = null
      body.rollout_pause_reason = null
    }

    const { error: errorChannelUpdate } = await invokeCapgoCliApi('channel', {
      apikey,
      method: 'POST',
      body,
      supaHost,
      supaAnon,
    })

    if (errorChannelUpdate) {
      s?.stop(`Cannot update channel ${channel.name} ${formatError(errorChannelUpdate)}`)
      throw new Error(`Cannot update channel ${channel.name}: ${formatError(errorChannelUpdate)}`)
    }

    s?.stop(`✅ Channel ${channel.name} unlinked`)
  }

  if (!silent)
    outro(`Version unlinked from ${channelFound.length} channel${channelFound.length > 1 ? 's' : ''}`)
}

export function createChannel(
  options: CapgoHttpOptions,
  update: {
    app_id: string
    channel: string
    version?: string | null
    public?: boolean
    allow_device_self_set?: boolean
    [key: string]: unknown
  },
) {
  return invokeCapgoCliApi('channel', {
    apikey: options.apikey,
    method: 'POST',
    body: update,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
}

export function delChannel(options: CapgoHttpOptions, name: string, appId: string, deleteBundle = false) {
  return invokeCapgoCliApi('channel', {
    apikey: options.apikey,
    method: 'DELETE',
    body: {
      app_id: appId,
      channel: name,
      delete_bundle: deleteBundle,
    },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
}

// Channel reads stay on PostgREST so RLS (app.read / channel.read) matches console and
// preview-key behavior. HTTP GET /channel requires app.read_channels, which preview keys lack.
export function findChannel(supabase: SupabaseClient<Database>, appId: string, name: string) {
  return supabase
    .from('channels')
    .select()
    .eq('app_id', appId)
    .eq('name', name)
    .single()
}

export function findBundleIdByChannelName(supabase: SupabaseClient<Database>, appId: string, name: string) {
  return supabase
    .from('channels')
    .select(`
      id,
      version:app_versions!channels_version_fkey(id, name)
    `)
    .eq('app_id', appId)
    .eq('name', name)
    .single()
    .throwOnError()
    .then(({ data }) => data?.version)
}

export type { Channel } from '../schemas/channel'
type Channel = import('../schemas/channel').Channel

export function displayChannels(data: Channel[], silent = false) {
  if (silent)
    return

  const t = new Table()
  t.theme = Table.roundTheme
  t.headers = ['Name', 'Version', 'Public', 'iOS', 'Android', 'Auto Update', 'Native Auto Update', 'Device Self Set', 'Emulator', 'Device', 'Dev', 'Prod']
  t.rows = []

  for (const row of data.toReversed()) {
    t.rows.push([
      row.name,
      row.version?.name,
      row.public ? '✅' : '❌',
      row.ios ? '✅' : '❌',
      row.android ? '✅' : '❌',
      row.disable_auto_update,
      row.disable_auto_update_under_native ? '❌' : '✅',
      row.allow_device_self_set ? '✅' : '❌',
      row.allow_emulator ? '✅' : '❌',
      row.allow_device ? '✅' : '❌',
      row.allow_dev ? '✅' : '❌',
      row.allow_prod ? '✅' : '❌',
    ])
  }

  log.success('Channels')
  log.success(t.toString())
}

export async function getActiveChannels(
  options: CapgoHttpOptions,
  appid: string,
) {
  const all: Channel[] = []
  let page = 0
  while (true) {
    const { data, error: vError } = await fetchChannelsPage(appid, page, options)
    if (vError) {
      if (!options.silent)
        log.error(`App ${appid} not found in database`)
      throw new Error(`App ${appid} not found in database: ${formatError(vError)}`)
    }
    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    all.push(...batch.map(normalizeHttpChannel))
    if (batch.length < 50)
      break
    page += 1
  }
  return all
}
