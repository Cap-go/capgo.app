import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Each entry: a prod-pending migration and the latest prod version it sorts before.
 * - 22.63.0: five migrations older than 20261117115240.
 * - 22.73.x: no-op 20261120001201 follow-up to the restored 20261117152120 (#4190
 *   renamed the prod-applied file), older than 20261125000500.
 */
const PENDING_OUT_OF_ORDER: Record<string, string> = {
  'supabase/migrations/20261117014348_console_request_fanout.sql': '20261117115240',
  'supabase/migrations/20261117014945_stats_rollout_cron_load.sql': '20261117115240',
  'supabase/migrations/20261117030227_app_storage_cleanup_passes.sql': '20261117115240',
  'supabase/migrations/20261117031521_billing_profile_currency.sql': '20261117115240',
  'supabase/migrations/20261117032322_simulator_idle_stop.sql': '20261117115240',
  'supabase/migrations/20261120001201_storage_gb_hours_billing.sql': '20261125000500',
}

function extractPushReleaseAllowlist(script: string): string[] {
  const matches = script.matchAll(/supabase\/migrations\/[0-9]{14}_[^\s|)]+\.sql/g)
  return [...matches].map(m => m[0])
}

describe('push-release-migrations out-of-order allowlist', () => {
  it('lists every prod-pending migration older than the latest applied version', () => {
    const script = readFileSync(new URL('../scripts/push-release-migrations.sh', import.meta.url), 'utf8')
    const allowlist = new Set(extractPushReleaseAllowlist(script))
    const expected = Object.keys(PENDING_OUT_OF_ORDER)
    expect(allowlist.size).toBe(expected.length)
    for (const path of expected) {
      expect(allowlist.has(path), `missing allowlist entry for ${path}`).toBe(true)
    }
    for (const path of allowlist) {
      const version = path.match(/^supabase\/migrations\/([0-9]{14})_/)?.[1]
      const prodLatest = PENDING_OUT_OF_ORDER[path]
      expect(prodLatest, `unexpected allowlist entry ${path}`).toBeDefined()
      expect(version && version < prodLatest, `allowlist entry ${path} is not out of order`).toBe(true)
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