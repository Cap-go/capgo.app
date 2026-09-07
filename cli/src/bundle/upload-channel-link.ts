import type { OptionsUpload } from './upload_interface'

export type ChannelRolloutState = {
  rollout_enabled?: boolean | null
  rollout_version?: number | null
}

export function hasActiveRollout(channel: ChannelRolloutState | null | undefined): boolean {
  return !!channel?.rollout_enabled && channel.rollout_version != null
}

export function isStableChannelLinkUpload(
  options: Pick<OptionsUpload, 'rollout' | 'rolloutPercentageBps' | 'rolloutAdvance'>,
): boolean {
  return options.rollout == null
    && options.rolloutPercentageBps == null
    && options.rolloutAdvance !== true
}

export function shouldFailOnActiveRollout(
  options: Pick<OptionsUpload, 'failOnActiveRollout' | 'rollout' | 'rolloutPercentageBps' | 'rolloutAdvance'>,
  channel: ChannelRolloutState | null | undefined,
): boolean {
  return !!options.failOnActiveRollout
    && isStableChannelLinkUpload(options)
    && hasActiveRollout(channel)
}

export function formatActiveRolloutResetWarning(channelName: string): string {
  return `Channel "${channelName}" has an active progressive rollout. Linking this bundle as stable resets that rollout so devices receive the new stable bundle instead of the previous rollout target.`
}

export function formatStableChannelLinkSuccess(channelName: string, bundle: string, clearedActiveRollout: boolean): string {
  if (clearedActiveRollout)
    return `Linked @${bundle} to channel "${channelName}" as stable and cleared the active progressive rollout.`

  return `Linked @${bundle} to channel "${channelName}" as stable.`
}

export function formatFailOnActiveRolloutMessage(channelName: string): string {
  return `Upload aborted: channel "${channelName}" has an active progressive rollout. Pass --rollout or --rollout-advance to manage rollout, or omit --fail-on-active-rollout to link as stable and clear the rollout.`
}
