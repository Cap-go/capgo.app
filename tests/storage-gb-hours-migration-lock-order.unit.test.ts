import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/20261117152120_storage_gb_hours_billing.sql', import.meta.url),
  'utf8',
)

describe('storage gb-hours billing migration lock order', () => {
  it('sets lock_timeout and locks app_versions before apps before trigger DDL', () => {
    const firstAppsTrigger = migration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.apps/)
    const firstAppVersionsTrigger = migration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.app_versions/)
    expect(firstAppsTrigger).toBeGreaterThan(0)
    expect(firstAppVersionsTrigger).toBeGreaterThan(firstAppsTrigger)

    const lockTimeout = migration.indexOf(`SET LOCAL lock_timeout = '5s'`)
    const lockTables = migration.indexOf('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE')
    expect(lockTimeout).toBeGreaterThan(0)
    expect(lockTables).toBeGreaterThan(lockTimeout)

    for (const index of [lockTimeout, lockTables]) {
      expect(index).toBeLessThan(firstAppsTrigger)
      expect(index).toBeLessThan(firstAppVersionsTrigger)
    }

    expect(migration.slice(0, lockTables)).toContain('capgo-22.63.1')
    expect(migration.slice(lockTables, firstAppsTrigger)).not.toMatch(/DROP TRIGGER|CREATE TRIGGER/)
  })
})