import type { Database } from '~/types/database.types'

export type CiEncryptionBundle = Pick<Database['public']['Tables']['app_versions']['Row'], 'name' | 'key_id' | 'deleted' | 'deleted_at'>
export type CiProductionEncryptionEvidence = 'encrypted' | 'plaintext' | 'unknown'
export type CiEncryptionChannel = Pick<Database['public']['Tables']['channels']['Row'], 'rollout_enabled' | 'rollout_version'> & {
  current_version: CiEncryptionBundle | null
  rollout_bundle: CiEncryptionBundle | null
}

/** Enabled rollouts can still serve existing cohorts while paused or at zero percent. */
export function ciChannelEncryptionBundles(channel: CiEncryptionChannel): Array<CiEncryptionBundle | null> {
  return channel.rollout_enabled && channel.rollout_version !== null
    ? [channel.current_version, channel.rollout_bundle]
    : [channel.current_version]
}

/** Infer the key requirement only from readable, live production bundle candidates. */
export function ciProductionEncryptionEvidence(bundles: readonly (CiEncryptionBundle | null)[]): CiProductionEncryptionEvidence {
  let allPlaintext = bundles.length > 0
  for (const bundle of bundles) {
    const name = typeof bundle?.name === 'string' ? bundle.name.trim() : ''
    if (!bundle || bundle.deleted !== false || bundle.deleted_at !== null || !name || name === 'builtin' || name === 'unknown') {
      allPlaintext = false
      continue
    }
    if (bundle.key_id?.trim())
      return 'encrypted'
  }
  return allPlaintext ? 'plaintext' : 'unknown'
}
