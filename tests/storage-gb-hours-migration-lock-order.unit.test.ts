import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/20261117152120_storage_gb_hours_billing.sql', import.meta.url),
  'utf8',
)

describe('storage gb-hours billing migration lock order', () => {
  it('locks app_versions and apps before the first trigger DDL on those tables', () => {
    const firstAppsTrigger = migration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.apps/)
    const firstAppVersionsTrigger = migration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.app_versions/)
    expect(firstAppsTrigger).toBeGreaterThan(0)
    expect(firstAppVersionsTrigger).toBeGreaterThan(firstAppsTrigger)

    const lockAppVersions = migration.indexOf('LOCK TABLE public.app_versions IN ACCESS EXCLUSIVE MODE')
    const lockApps = migration.indexOf('LOCK TABLE public.apps IN ACCESS EXCLUSIVE MODE')
    const lockVersionMeta = migration.indexOf('LOCK TABLE public.version_meta IN ACCESS EXCLUSIVE MODE')
    const lockDailyStorageHourly = migration.indexOf('LOCK TABLE public.daily_storage_hourly IN ACCESS EXCLUSIVE MODE')

    expect(lockAppVersions).toBeGreaterThan(0)
    expect(lockApps).toBeGreaterThan(lockAppVersions)
    expect(lockVersionMeta).toBeGreaterThan(lockApps)
    expect(lockDailyStorageHourly).toBeGreaterThan(lockVersionMeta)

    for (const lockIndex of [lockAppVersions, lockApps, lockVersionMeta, lockDailyStorageHourly]) {
      expect(lockIndex).toBeLessThan(firstAppsTrigger)
      expect(lockIndex).toBeLessThan(firstAppVersionsTrigger)
    }
  })
})