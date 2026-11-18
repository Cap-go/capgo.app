import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/20261117152120_storage_gb_hours_billing.sql', import.meta.url),
  'utf8',
)

const lockBlock =
  `SET LOCAL lock_timeout = '5s';\nLOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE;\n\n`

const lockTimeout = migration.indexOf(`SET LOCAL lock_timeout = '5s'`)
const lockTables = migration.indexOf('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE')
const fkDrop = migration.indexOf('DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey')
const firstAppsTrigger = migration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.apps/)
const firstAppVersionsTrigger = migration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.app_versions/)

function lockPrecedesFkDrop(sql: string) {
  const lock = sql.indexOf('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE')
  const fk = sql.indexOf('DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey')
  return lock > 0 && fk > 0 && lock < fk
}

describe('storage gb-hours billing migration lock order', () => {
  it('locks app_versions and apps before the daily_storage_hourly FK drop and trigger DDL', () => {
    expect(lockTimeout).toBeGreaterThan(0)
    expect(lockTables).toBeGreaterThan(lockTimeout)
    expect(fkDrop).toBeGreaterThan(lockTables)
    expect(firstAppsTrigger).toBeGreaterThan(fkDrop)
    expect(firstAppVersionsTrigger).toBeGreaterThan(firstAppsTrigger)

    for (const index of [lockTimeout, lockTables]) {
      expect(index).toBeLessThan(fkDrop)
      expect(index).toBeLessThan(firstAppsTrigger)
      expect(index).toBeLessThan(firstAppVersionsTrigger)
    }

    expect(migration.slice(0, lockTables)).toContain('capgo-22.63.1')
    expect(migration.slice(lockTables, fkDrop)).not.toMatch(
      /ALTER TABLE public\.(apps|app_versions)|DROP TRIGGER|CREATE TRIGGER/,
    )
  })

  it('fails the ordering check if the lock block sits after the FK drop (mutation guard)', () => {
    const withoutEarlyLock = migration.replace(lockBlock, '')
    const fkStatementEnd = withoutEarlyLock.indexOf('DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey;')
      + 'DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey;'.length
    const lateLockMigration = `${withoutEarlyLock.slice(0, fkStatementEnd)}\n\n${lockBlock}${withoutEarlyLock.slice(fkStatementEnd)}`

    expect(lockPrecedesFkDrop(migration)).toBe(true)
    expect(lockPrecedesFkDrop(lateLockMigration)).toBe(false)
  })
})