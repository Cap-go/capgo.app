import type { CapgoClient } from '../utils'
import type { AutoBumpLevel } from '../versionHelpers'
import { log } from '@clack/prompts'
import { fetchBundleManifest, fetchCliChannels, fetchLatestBundle } from '../api/cli-data'
import { formatError, generateManifest, invokeCapgoCliApi } from '../utils'

export type ManifestEntry = { file: string, hash: string }

export type ManifestDiff = {
  added: string[]
  removed: string[]
  changed: string[]
  counts: {
    added: number
    removed: number
    changed: number
  }
}

export type AiBumpDecision = {
  level: AutoBumpLevel
  reason: string
}

const MAX_PATHS_SENT_TO_AI = 100

export function diffManifests(
  local: ManifestEntry[],
  remote: ManifestEntry[],
): ManifestDiff {
  const remoteMap = new Map(remote.map(entry => [entry.file, entry.hash]))
  const localMap = new Map(local.map(entry => [entry.file, entry.hash]))

  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const [file, hash] of localMap) {
    const remoteHash = remoteMap.get(file)
    if (remoteHash === undefined)
      added.push(file)
    else if (remoteHash !== hash)
      changed.push(file)
  }

  for (const [file] of remoteMap) {
    if (!localMap.has(file))
      removed.push(file)
  }

  return {
    added,
    removed,
    changed,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
  }
}

function limitPathsForAi(diff: ManifestDiff): ManifestDiff {
  return {
    added: diff.added.slice(0, MAX_PATHS_SENT_TO_AI),
    removed: diff.removed.slice(0, MAX_PATHS_SENT_TO_AI),
    changed: diff.changed.slice(0, MAX_PATHS_SENT_TO_AI),
    counts: diff.counts,
  }
}

export async function fetchRemoteManifest(
  client: CapgoClient,
  versionId: number,
): Promise<ManifestEntry[]> {
  let data: Awaited<ReturnType<typeof fetchBundleManifest>>
  try {
    data = await fetchBundleManifest(client, versionId)
  }
  catch (error) {
    throw new Error(`Cannot fetch remote manifest: ${formatError(error)}`)
  }

  return data
    .filter(row => row.file_name && row.file_hash)
    .map(row => ({
      file: row.file_name as string,
      hash: row.file_hash as string,
    }))
}

export async function resolveBaseVersionForAutoBump(
  client: CapgoClient,
  appid: string,
  channels: string[],
): Promise<{ name: string, id: number } | null> {
  const primaryChannel = channels[0]
  if (primaryChannel) {
    const rows = await fetchCliChannels(client, appid, primaryChannel).catch(() => [])
    const version = rows[0]?.version_info
    if (version && !version.deleted && version.id && version.name)
      return { name: version.name, id: version.id }
  }

  // Include deleted versions for name occupancy (same semantics as auto-bump base).
  try {
    return await fetchLatestBundle(client, appid)
  }
  catch (error) {
    log.warn(`Cannot fetch latest remote version for AI auto-bump: ${formatError(error)}`)
    return null
  }
}

export async function requestAiBumpLevel(options: {
  apikey: string
  appId: string
  baseVersion: string
  manifestDiff: ManifestDiff
  nativeCompatibility?: { summary: string, breaking?: boolean }
  apiHost?: string
}): Promise<AiBumpDecision> {
  const { data, error } = await invokeCapgoCliApi<{ level?: string, reason?: string }>('bundle/ai_bump_level', {
    apikey: options.apikey,
    body: {
      appId: options.appId,
      baseVersion: options.baseVersion,
      manifestDiff: limitPathsForAi(options.manifestDiff),
      nativeCompatibility: options.nativeCompatibility,
    },
    apiHost: options.apiHost,
  })

  if (error)
    throw error

  const level = typeof data?.level === 'string' ? data.level.trim().toLowerCase() : ''
  const reason = typeof data?.reason === 'string' ? data.reason.trim() : ''
  if (!['major', 'minor', 'patch', 'metadata'].includes(level) || !reason)
    throw new Error('AI bump endpoint returned an invalid response')

  return {
    level: level as AutoBumpLevel,
    reason,
  }
}

export async function resolveAutoBumpLevelFromAi(ctx: {
  client: CapgoClient
  appid: string
  channels: string[]
  path: string
  apikey: string
  options?: { apiHost?: string }
}): Promise<AiBumpDecision> {
  const base = await resolveBaseVersionForAutoBump(ctx.client, ctx.appid, ctx.channels)
  if (!base) {
    return {
      level: 'patch',
      reason: 'No previous Capgo version; defaulting to patch bump without AI.',
    }
  }

  try {
    const localManifest = await generateManifest(ctx.path)
    const remoteManifest = await fetchRemoteManifest(ctx.client, base.id)
    const manifestDiff = diffManifests(localManifest, remoteManifest)
    return await requestAiBumpLevel({
      apikey: ctx.apikey,
      appId: ctx.appid,
      baseVersion: base.name,
      manifestDiff,
      apiHost: ctx.options?.apiHost,
    })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      level: 'minor',
      reason: `AI unavailable (${message}); falling back to minor.`,
    }
  }
}
