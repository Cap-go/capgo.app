import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { formatError } from '../utils'

type CapgoSupabaseClient = SupabaseClient<Database>

export async function assertChannelExists(supabase: CapgoSupabaseClient, appId: string, channelName: string) {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name')
    .eq('app_id', appId)
    .eq('name', channelName)
    .maybeSingle()

  if (error)
    throw new Error(`Cannot load channel ${channelName}: ${formatError(error)}`)
  if (!data)
    throw new Error(`Channel ${channelName} not found for app ${appId}`)

  return data
}

export async function setDefaultDownloadChannel(
  supabase: CapgoSupabaseClient,
  appId: string,
  channelName: string,
) {
  const channel = await assertChannelExists(supabase, appId, channelName)

  const { error: enableError } = await supabase
    .from('channels')
    .update({ public: true })
    .eq('id', channel.id)

  if (enableError)
    throw new Error(`Could not enable default download channel: ${formatError(enableError)}`)

  const { error: disableError } = await supabase
    .from('channels')
    .update({ public: false })
    .eq('app_id', appId)
    .neq('id', channel.id)

  if (disableError)
    throw new Error(`Could not update other channels: ${formatError(disableError)}`)
}

export async function disableDownloadChannels(supabase: CapgoSupabaseClient, appId: string) {
  const { error } = await supabase
    .from('channels')
    .update({ public: false })
    .eq('app_id', appId)

  if (error)
    throw new Error(`Could not disable download channels: ${formatError(error)}`)
}
