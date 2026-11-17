export interface PreviousDeployRow {
  channel_id: number
  version_id: number
  created_at: string | null
  deployed_at: string | null
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
