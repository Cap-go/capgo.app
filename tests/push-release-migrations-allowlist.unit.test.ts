import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PROD_LATEST_VERSION = '20261117115240'

/** Pending in prod as of release train 22.63.0; timestamp sorts before PROD_LATEST_VERSION. */
const PENDING_OUT_OF_ORDER = [
  'supabase/migrations/20261117014348_console_request_fanout.sql',
  'supabase/migrations/20261117014945_stats_rollout_cron_load.sql',
  'supabase/migrations/20261117030227_app_storage_cleanup_passes.sql',
  'supabase/migrations/20261117031521_billing_profile_currency.sql',
  'supabase/migrations/20261117032322_simulator_idle_stop.sql',
]

function extractPushReleaseAllowlist(script: string): string[] {
  const matches = script.matchAll(/supabase\/migrations\/[0-9]{14}_[^\s|)]+\.sql/g)
  return [...matches].map(m => m[0])
}

describe('push-release-migrations out-of-order allowlist', () => {
  it('lists every prod-pending migration older than the latest applied version', () => {
    const script = readFileSync(new URL('../scripts/push-release-migrations.sh', import.meta.url), 'utf8')
    const allowlist = new Set(extractPushReleaseAllowlist(script))
    expect(allowlist.size).toBe(PENDING_OUT_OF_ORDER.length)
    for (const path of PENDING_OUT_OF_ORDER) {
      expect(allowlist.has(path), `missing allowlist entry for ${path}`).toBe(true)
    }
    for (const path of allowlist) {
      const version = path.match(/^supabase\/migrations\/([0-9]{14})_/)?.[1]
      expect(version && version < PROD_LATEST_VERSION, `unexpected allowlist entry ${path}`).toBe(true)
    }
  })

  it('passes DATABASE_URL to every supabase db push', () => {
    const script = readFileSync(new URL('../scripts/push-release-migrations.sh', import.meta.url), 'utf8')
    const pushes = script.match(/supabase db push[^\n)]*/g) ?? []
    expect(pushes).toHaveLength(3)
    for (const push of pushes)
      expect(push).toContain('--db-url "$DATABASE_URL"')
  })
})