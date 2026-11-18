import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dataMigration = readFileSync(
  new URL('../supabase/migrations/20261117152410_storage_gb_hours_billing_data.sql', import.meta.url),
  'utf8',
)
const locksMigration = readFileSync(
  new URL('../supabase/migrations/20261117152411_storage_gb_hours_billing_apps_locks.sql', import.meta.url),
  'utf8',
)

const lockBlock =
  `SET LOCAL lock_timeout = '5s';\nLOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE;\n\n`

const fkDrop = 'DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey'

function lockPrecedesFkDrop(sql: string) {
  const lock = sql.indexOf('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE')
  const fk = sql.indexOf(fkDrop)
  return lock > 0 && fk > 0 && lock < fk
}

function lockListsAppVersionsBeforeApps(sql: string) {
  const line = sql.match(/LOCK TABLE ([^\n]+) IN ACCESS EXCLUSIVE MODE/)?.[1] ?? ''
  const tables = line.split(',').map(t => t.trim())
  const av = tables.indexOf('public.app_versions')
  const apps = tables.indexOf('public.apps')
  return av >= 0 && apps > av
}

describe('storage gb-hours billing migration lock order', () => {
  it('keeps heavy data migration off apps/app_versions DDL', () => {
    expect(dataMigration).not.toMatch(/LOCK TABLE public\.(apps|app_versions)/)
    expect(dataMigration).not.toContain(fkDrop)
    expect(dataMigration).not.toMatch(/DROP TRIGGER IF EXISTS \w+ ON public\.(apps|app_versions)/)
    expect(dataMigration).not.toMatch(/CREATE TRIGGER[\s\S]* ON public\.(apps|app_versions)/)
  })

  it('locks app_versions before apps before the FK drop and trigger DDL in part 2', () => {
    const firstAppsTrigger = locksMigration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.apps/)
    const firstAppVersionsTrigger = locksMigration.search(/DROP TRIGGER IF EXISTS \w+ ON public\.app_versions/)
    expect(firstAppsTrigger).toBeGreaterThan(0)
    expect(firstAppVersionsTrigger).toBeGreaterThan(firstAppsTrigger)

    const lockTimeout = locksMigration.indexOf(`SET LOCAL lock_timeout = '5s'`)
    const lockTables = locksMigration.indexOf('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE')
    const fkDropIndex = locksMigration.indexOf(fkDrop)

    expect(lockTimeout).toBeGreaterThan(0)
    expect(lockTables).toBeGreaterThan(lockTimeout)
    expect(fkDropIndex).toBeGreaterThan(lockTables)
    expect(lockListsAppVersionsBeforeApps(locksMigration)).toBe(true)

    for (const index of [lockTimeout, lockTables]) {
      expect(index).toBeLessThan(fkDropIndex)
      expect(index).toBeLessThan(firstAppsTrigger)
      expect(index).toBeLessThan(firstAppVersionsTrigger)
    }
  })

  it('fails the ordering check if part 2 lock sits after the FK drop (mutation guard)', () => {
    const withoutEarlyLock = locksMigration.replace(lockBlock, '')
    const fkStatementEnd = withoutEarlyLock.indexOf(`${fkDrop};`)
      + `${fkDrop};`.length
    const lateLockMigration = `${withoutEarlyLock.slice(0, fkStatementEnd)}\n\n${lockBlock}${withoutEarlyLock.slice(fkStatementEnd)}`

    expect(lockPrecedesFkDrop(locksMigration)).toBe(true)
    expect(lockPrecedesFkDrop(lateLockMigration)).toBe(false)
  })
})