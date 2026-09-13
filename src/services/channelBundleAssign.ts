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

export function isBundleLinkedToChannel(
  channel: Pick<ChannelRolloutState, 'version' | 'rollout_version'>,
  versionId: number,
) {
  return channel.version === versionId || channel.rollout_version === versionId
}

export function buildChannelBundleUnlinkUpdate(
  channel: Pick<ChannelRolloutState, 'version' | 'rollout_version'>,
  versionId: number,
): Database['public']['Tables']['channels']['Update'] | null {
  if (channel.rollout_version === versionId) {
    return {
      rollout_version: null,
      rollout_enabled: false,
      rollout_percentage_bps: 0,
      rollout_paused_at: null,
      rollout_pause_reason: null,
    }
  }
  if (channel.version === versionId)
    return { version: null }
  return null
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
    }
  }

  return {
    version: versionId,
  }
}
