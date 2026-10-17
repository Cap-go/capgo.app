import type { ReadOnlyContext } from '../../contracts.ts'

export const LIFECYCLE_CONTRACT = 'new-emails-v2-2026-10-17'
export const LIFECYCLE_ROLLOUT_KEYS = ['BENTO_EVENT_DISPATCH_ENABLED', 'BENTO_LIFECYCLE_V2_SENDER_CONTRACT', 'BENTO_LIFECYCLE_V2_LEGACY_HANDOFF'] as const

export async function lifecycleSettings(read: ReadOnlyContext, overrides: Readonly<Record<string, string | undefined>>, keys: readonly string[]) {
  const values: Record<string, string> = {}
  const missing = keys.filter(key => overrides[key] === undefined)
  if (missing.length) {
    const rows = await read.query<{ name: string, decrypted_secret: string }>('SELECT name, decrypted_secret FROM vault.decrypted_secrets WHERE name = ANY($1::text[])', [missing])
    for (const row of rows)
      values[row.name] = row.decrypted_secret?.trim()
  }
  for (const key of keys) {
    if (overrides[key] !== undefined)
      values[key] = overrides[key]!.trim()
  }
  return values
}

export async function lifecycleReady(read: ReadOnlyContext, overrides: Readonly<Record<string, string | undefined>>) {
  const settings = await lifecycleSettings(read, overrides, LIFECYCLE_ROLLOUT_KEYS)
  return settings.BENTO_EVENT_DISPATCH_ENABLED === 'true'
    && settings.BENTO_LIFECYCLE_V2_SENDER_CONTRACT === LIFECYCLE_CONTRACT
    && settings.BENTO_LIFECYCLE_V2_LEGACY_HANDOFF === LIFECYCLE_CONTRACT
}
