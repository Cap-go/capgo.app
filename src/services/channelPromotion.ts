import type { PermissionCheckRequest } from '~/services/permissions'
import { checkPermissionsBatch } from '~/services/permissions'

export interface ChannelPromotionTarget {
  id: number
  name: string
}

export type ChannelPromotionPermissionChecker = (
  requests: PermissionCheckRequest[],
) => Promise<boolean[]>

export async function findChannelsWithoutPromotionPermission(
  appId: string,
  channels: ChannelPromotionTarget[],
  permissionChecker: ChannelPromotionPermissionChecker = checkPermissionsBatch,
) {
  if (channels.length === 0)
    return []

  let allowed: boolean[]
  try {
    // One batched permission RPC for every linked channel.
    allowed = await permissionChecker(channels.map(channel => ({
      permissions: 'channel.promote_bundle',
      scope: { appId, channelId: channel.id },
    })))
  }
  catch {
    // Fail closed: treat every channel as not promotable.
    return [...channels]
  }

  return channels.filter((_channel, idx) => allowed[idx] !== true)
}

export function formatChannelPromotionTargets(channels: ChannelPromotionTarget[]) {
  return channels.map(channel => channel.name).join(', ')
}
