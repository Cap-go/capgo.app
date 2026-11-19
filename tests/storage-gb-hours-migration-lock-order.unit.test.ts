import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath = new URL(
  '../supabase/migrations/20261118193000_storage_gb_hours_billing.sql',
  import.meta.url,
)
const migration = readFileSync(migrationPath, 'utf8')

const appsLockMarker = '$capgo_lock_apps_for_storage_triggers$'
const dshLockMarker = '$capgo_lock_daily_storage_hourly$'
const versionMetaLockMarker = '$capgo_lock_version_meta$'
const fkDropMarker = '$capgo_drop_daily_storage_hourly_app_fk$'

function indexAfter(marker: string, from = 0) {
  const at = migration.indexOf(marker, from)
  expect(at).toBeGreaterThan(0)
  return at
}

describe('storage gb-hours billing migration lock order (source positions)', () => {
  it('takes apps/app_versions and FK drop before daily_storage_hourly and version_meta locks', () => {
    const begin = migration.indexOf('BEGIN;')
    const commit = migration.lastIndexOf('COMMIT;')
    const appsLock = indexAfter(appsLockMarker, begin)
    const fkDropIndex = indexAfter(fkDropMarker, appsLock)
    const dshLock = indexAfter(dshLockMarker, fkDropIndex)
    const versionMetaLock = indexAfter(versionMetaLockMarker, dshLock)
    const firstAppsTrigger = migration.slice(versionMetaLock).search(/DROP TRIGGER IF EXISTS \w+ ON public\.apps/)
    expect(firstAppsTrigger).toBeGreaterThan(0)
    const firstAppsTriggerAbs = versionMetaLock + firstAppsTrigger

    expect(begin).toBeGreaterThan(0)
    expect(commit).toBeGreaterThan(begin)
    expect(fkDropIndex).toBeGreaterThan(appsLock)
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey')
    expect(dshLock).toBeGreaterThan(fkDropIndex)
    expect(versionMetaLock).toBeGreaterThan(dshLock)
    expect(firstAppsTriggerAbs).toBeGreaterThan(versionMetaLock)

    const appsLockCount = migration.match(/\$capgo_lock_apps_for_storage_triggers\$/g)?.length ?? 0
    expect(appsLockCount).toBe(2)

    for (const match of migration.matchAll(/SET LOCAL lock_timeout = '([^']+)'/g)) {
      expect(match[1]).toBe('500ms')
    }
    expect(migration).not.toMatch(/lock_timeout = '5s'/)
    expect(migration).not.toMatch(/lock_timeout = '1s'/)
  })

  it('wraps the daily_storage_hourly FK drop in a retry DO block', () => {
    expect(migration).toMatch(
      /DO \$capgo_drop_daily_storage_hourly_app_fk\$[\s\S]*DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey[\s\S]*\$capgo_drop_daily_storage_hourly_app_fk\$;/,
    )
  })

  it('wraps legacy daily_storage drops in a retry DO block', () => {
    expect(migration).toContain('$capgo_drop_legacy_daily_storage$')
    expect(migration).toMatch(
      /DO \$capgo_drop_legacy_daily_storage\$[\s\S]*DROP FUNCTION IF EXISTS public\.read_storage_usage[\s\S]*DROP TABLE IF EXISTS public\.daily_storage[\s\S]*\$capgo_drop_legacy_daily_storage\$;/,
    )
  })
})