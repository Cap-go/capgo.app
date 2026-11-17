export interface PreviousDeployRow {
  channel_id: number
  version_id: number
  created_at: string | null
  deployed_at: string | null
}

/** Channels per get_channels_previous_deploys call (the RPC refuses more than 1000). */
const MAX_CHANNELS_PER_LOOKBACK = 1000

/** Split channel ids into disjoint chunks the lookback RPC accepts. */
export function chunkChannelIds(channelIds: readonly number[], maxChannels = MAX_CHANNELS_PER_LOOKBACK): number[][] {
  const chunks: number[][] = []
  for (let index = 0; index < channelIds.length; index += maxChannels)
    chunks.push(channelIds.slice(index, index + maxChannels))
  return chunks
}

export interface PreviousDeployCandidate {
  versionId: number
  deployedAt: string | null
}

/**
 * Group get_channels_previous_deploys rows into one newest-first candidate list
 * per channel, in the order the channels were requested. Channels without an
 * earlier deployment are left out, like the per-channel queries this replaced.
 */
export function groupPreviousDeploysByChannel(channelIds: readonly number[], rows: readonly PreviousDeployRow[]): PreviousDeployCandidate[][] {
  const byChannel = new Map<number, PreviousDeployCandidate[]>()
  for (const row of rows) {
    const candidates = byChannel.get(row.channel_id) ?? []
    candidates.push({ versionId: row.version_id, deployedAt: row.created_at ?? row.deployed_at ?? null })
    byChannel.set(row.channel_id, candidates)
  }
  const grouped: PreviousDeployCandidate[][] = []
  for (const channelId of channelIds) {
    const candidates = byChannel.get(channelId)
    if (candidates?.length)
      grouped.push(candidates)
  }
  return grouped
}
