import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { confirm as confirmC, intro, log, outro, spinner } from '@clack/prompts'
import { Table } from '@sauber/table'
import { formatError } from '../utils'

interface CheckVersionOptions {
  silent?: boolean
  autoUnlink?: boolean
  channelName?: string
  requireMatch?: boolean
}

export async function checkVersionNotUsedInChannel(
  supabase: SupabaseClient<Database>,
  appid: string,
  versionData: Database['public']['Tables']['app_versions']['Row'],
  options: CheckVersionOptions = {},
) {
  const { silent = false, autoUnlink = false, channelName, requireMatch = false } = options
  let query = supabase
    .from('channels')
    .select()
    .eq('app_id', appid)
    .or(`version.eq.${versionData.id},rollout_version.eq.${versionData.id}`)

  if (channelName)
    query = query.eq('name', channelName)

  const { data: channelFound, error: errorChannel } = await query

  if (errorChannel) {
    if (!silent)
      log.error(`Cannot check Version ${appid}@${versionData.name}: ${formatError(errorChannel)}`)
    throw new Error(`Cannot check version ${appid}@${versionData.name}: ${formatError(errorChannel)}`)
  }

  if (!channelFound?.length) {
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

    const patch: Database['public']['Tables']['channels']['Update'] = {}
    if (channel.version === versionData.id) {
      patch.version = null
    }
    if (channel.rollout_version === versionData.id) {
      patch.rollout_version = null
      patch.rollout_enabled = false
      patch.rollout_percentage_bps = 0
      patch.rollout_paused_at = null
      patch.rollout_pause_reason = null
    }

    const { error: errorChannelUpdate } = await supabase
      .from('channels')
      .update(patch)
      .eq('id', channel.id)

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
  supabase: SupabaseClient<Database>,
  update: Database['public']['Tables']['channels']['Insert'],
) {
  return supabase
    .from('channels')
    .insert(update)
    .select()
    .single()
}

export function delChannel(supabase: SupabaseClient<Database>, name: string, appId: string) {
  return supabase
    .from('channels')
    .delete()
    .eq('name', name)
    .eq('app_id', appId)
    .single()
}

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
  supabase: SupabaseClient<Database>,
  appid: string,
  silent = false,
) {
  const { data, error: vError } = await supabase
    .from('channels')
    .select(`
      id,
      name,
      public,
      allow_emulator,
      allow_device,
      allow_dev,
      allow_prod,
      ios,
      android,
      allow_device_self_set,
      disable_auto_update_under_native,
      disable_auto_update,
      created_at,
      created_by,
      app_id,
      version:app_versions!channels_version_fkey(id, name)
    `)
    .eq('app_id', appid)
    .order('created_at', { ascending: false })

  if (vError) {
    if (!silent)
      log.error(`App ${appid} not found in database`)
    throw new Error(`App ${appid} not found in database: ${formatError(vError)}`)
  }

  return data as Channel[]
}
