import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types.ts'
import type { AutoBumpLevel } from '../versionHelpers.ts'
import { log } from '@clack/prompts'
import { generateManifest, invokeCapgoCliApi } from '../utils'

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
  supabase: SupabaseClient<Database>,
  versionId: number,
): Promise<ManifestEntry[]> {
  const { data, error } = await supabase
    .from('manifest')
    .select('file_name, file_hash')
    .eq('app_version_id', versionId)

  if (error)
    throw new Error(`Cannot fetch remote manifest: ${error.message}`)

  return (data ?? [])
    .filter(row => row.file_name && row.file_hash)
    .map(row => ({
      file: row.file_name as string,
      hash: row.file_hash as string,
    }))
}

export async function resolveBaseVersionForAutoBump(
  supabase: SupabaseClient<Database>,
  appid: string,
  channels: string[],
): Promise<{ name: string, id: number } | null> {
  const primaryChannel = channels[0]
  if (primaryChannel) {
    const { data, error } = await supabase
      .from('channels')
      .select('version:app_versions!channels_version_fkey( id, name, deleted )')
      .eq('app_id', appid)
      .eq('name', primaryChannel)

    if (!error && data && data.length > 0) {
      const version = data[0]?.version as { id: number, name: string, deleted: boolean } | null
      if (version && !version.deleted && version.id && version.name)
        return { name: version.name, id: version.id }
    }
  }

  // Include deleted versions for name occupancy (same semantics as auto-bump base).
  const { data, error } = await supabase
    .from('app_versions')
    .select('id, name')
    .eq('app_id', appid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    log.warn(`Cannot fetch latest remote version for AI auto-bump: ${error.message}`)
    return null
  }

  if (!data?.id || !data.name)
    return null

  return { name: data.name, id: data.id }
}

export async function requestAiBumpLevel(options: {
  apikey: string
  appId: string
  baseVersion: string
  manifestDiff: ManifestDiff
  nativeCompatibility?: { summary: string, breaking?: boolean }
  supaHost?: string
  supaAnon?: string
}): Promise<AiBumpDecision> {
  const { data, error } = await invokeCapgoCliApi<{ level?: string, reason?: string }>('bundle/ai_bump_level', {
    apikey: options.apikey,
    body: {
      appId: options.appId,
      baseVersion: options.baseVersion,
      manifestDiff: limitPathsForAi(options.manifestDiff),
      nativeCompatibility: options.nativeCompatibility,
    },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
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
  supabase: SupabaseClient<Database>
  appid: string
  channels: string[]
  path: string
  apikey: string
  options?: { supaHost?: string, supaAnon?: string }
}): Promise<AiBumpDecision> {
  const base = await resolveBaseVersionForAutoBump(ctx.supabase, ctx.appid, ctx.channels)
  if (!base) {
    return {
      level: 'patch',
      reason: 'No previous Capgo version; defaulting to patch bump without AI.',
    }
  }

  try {
    const localManifest = await generateManifest(ctx.path)
    const remoteManifest = await fetchRemoteManifest(ctx.supabase, base.id)
    const manifestDiff = diffManifests(localManifest, remoteManifest)
    return await requestAiBumpLevel({
      apikey: ctx.apikey,
      appId: ctx.appid,
      baseVersion: base.name,
      manifestDiff,
      supaHost: ctx.options?.supaHost,
      supaAnon: ctx.options?.supaAnon,
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
