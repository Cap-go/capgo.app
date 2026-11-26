import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  function runWithPending(pending: string) {
    const dir = mkdtempSync(join(tmpdir(), 'push-release-'))
    try {
      const fake = join(dir, 'supabase')
      writeFileSync(fake, `#!/usr/bin/env bash
if [[ " $* " == *" --dry-run "* ]]; then
  printf 'Found local migration files to be inserted before the last migration on remote database.\\n\\nRerun the command with --include-all flag to apply these migrations:\\n%s\\n' "$FAKE_PENDING" >&2
  exit 1
fi
echo "PUSH $*"
`)
      chmodSync(fake, 0o755)
      const script = fileURLToPath(new URL('../scripts/push-release-migrations.sh', import.meta.url))
      return spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: 'postgres://stub', FAKE_PENDING: pending },
      })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('pushes with --include-all when only the no-op 20261120001201 is out of order', () => {
    const result = runWithPending('supabase/migrations/20261120001201_storage_gb_hours_billing.sql')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PUSH db push --db-url postgres://stub --include-all')
  })

  it('stops with the repair step instead of replaying 20261117152120 over 20261120001201', () => {
    const result = runWithPending('supabase/migrations/20261117152120_storage_gb_hours_billing.sql')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('PUSH')
    expect(result.stderr).toContain('supabase migration repair --db-url "$DATABASE_URL" --status applied 20261117152120')
  })

  it('rejects without a repair step when 20261117152120 and 20261120001201 are both pending', () => {
    const result = runWithPending('supabase/migrations/20261117152120_storage_gb_hours_billing.sql\nsupabase/migrations/20261120001201_storage_gb_hours_billing.sql')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('PUSH')
    expect(result.stderr).toContain('both pending')
    expect(result.stderr).not.toContain('migration repair')
  })

  it('still rejects any other out-of-order migration', () => {
    const result = runWithPending('supabase/migrations/20261121000000_other.sql')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('PUSH')
  })
})
