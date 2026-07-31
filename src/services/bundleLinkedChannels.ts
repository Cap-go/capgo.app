import type { Database } from '~/types/supabase.types'
import { useSupabase } from '~/services/supabase'

export interface LinkedChannel {
  id: number
  name: string
  version?: number | null
  rollout_version?: number | null
  stable_linked?: boolean
  rollout_linked?: boolean
  version_info?: { name: string } | null
  rollout_version_info?: { name: string } | null
}

export function formatLinkedChannel(channel: LinkedChannel) {
  const names = [
    channel.version_info?.name,
    channel.rollout_version_info?.name,
  ].filter(Boolean)
  return `${channel.name} (${names.join(', ')})`
}

function mergeLinkedChannels(stableChannels: LinkedChannel[] = [], rolloutChannels: LinkedChannel[] = []) {
  const byId = new Map<number, LinkedChannel>()
  for (const channel of stableChannels)
    byId.set(channel.id, { ...channel, stable_linked: true })
  for (const channel of rolloutChannels) {
    const existing = byId.get(channel.id)
    byId.set(channel.id, {
      ...existing,
      ...channel,
      stable_linked: existing?.stable_linked,
      rollout_linked: true,
    })
  }
  return [...byId.values()]
}

export async function fetchLinkedChannelsForVersion(appId: string, versionId: number) {
  const supabase = useSupabase()
  const select = 'id, name, version, rollout_version, version_info:app_versions!channels_version_fkey(name), rollout_version_info:app_versions!channels_rollout_version_fkey(name)'
  const [stableResult, rolloutResult] = await Promise.all([
    supabase
      .from('channels')
      .select(select)
      .eq('app_id', appId)
      .eq('version', versionId),
    supabase
      .from('channels')
      .select(select)
      .eq('app_id', appId)
      .eq('rollout_version', versionId),
  ])

  if (stableResult.error)
    return { data: null, error: stableResult.error }
  if (rolloutResult.error)
    return { data: null, error: rolloutResult.error }

  return {
    data: mergeLinkedChannels(stableResult.data as LinkedChannel[], rolloutResult.data as LinkedChannel[]),
    error: null,
  }
}

export async function unlinkLinkedChannels(unlink: LinkedChannel[]) {
  if (unlink.length === 0)
    return null

  const supabase = useSupabase()
  const results = await Promise.all(unlink.map(async (channel) => {
    const update: Database['public']['Tables']['channels']['Update'] = {}
    if (channel.stable_linked)
      update.version = null
    if (channel.rollout_linked) {
      update.rollout_version = null
      update.rollout_enabled = false
      update.rollout_percentage_bps = 0
      update.rollout_paused_at = null
      update.rollout_pause_reason = null
    }
    return await supabase
      .from('channels')
      .update(update)
      .eq('id', channel.id)
  }))

  return results.find(({ error }) => error)?.error ?? null
}
