import type { Database } from '~/types/supabase.types'

export type ChannelBundleAssignTarget = 'auto' | 'stable' | 'rollout'

type ChannelRolloutState = Pick<
  Database['public']['Tables']['channels']['Row'],
  'rollout_enabled' | 'rollout_version' | 'version'
>

export function channelHasProgressiveRollout(channel: Pick<ChannelRolloutState, 'rollout_enabled' | 'rollout_version'>) {
  return channel.rollout_enabled || channel.rollout_version != null
}

export function resolveChannelBundleAssignTarget(
  channel: ChannelRolloutState,
  requestedTarget: ChannelBundleAssignTarget = 'auto',
): 'stable' | 'rollout' {
  if (requestedTarget === 'stable')
    return 'stable'
  if (requestedTarget === 'rollout')
    return 'rollout'
  return channelHasProgressiveRollout(channel) ? 'rollout' : 'stable'
}

export function buildChannelBundleAssignUpdate(
  channel: ChannelRolloutState,
  versionId: number,
  requestedTarget: ChannelBundleAssignTarget = 'auto',
): Database['public']['Tables']['channels']['Update'] {
  const assignmentTarget = resolveChannelBundleAssignTarget(channel, requestedTarget)

  if (assignmentTarget === 'rollout') {
    return {
      rollout_version: versionId,
      rollout_enabled: true,
    }
  }

  return {
    version: versionId,
  }
}
