import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath = new URL(
  '../supabase/migrations/20261118193000_storage_gb_hours_billing.sql',
  import.meta.url,
)
const migration = readFileSync(migrationPath, 'utf8')

const fkDrop = 'DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey'
const finalAppsLockMarker = '$capgo_lock_apps_for_storage_triggers$'
const lockTimeoutLiteral = `SET LOCAL lock_timeout = '500ms'`
const lockTables =
  'LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE'

function lockPrecedesFkDrop(sql: string) {
  const lock = sql.indexOf(lockTables)
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

function assertMigrationGuards(sql: string) {
  const begin = sql.indexOf('BEGIN;')
  const commit = sql.lastIndexOf('COMMIT;')
  const finalLockBlock = sql.indexOf(finalAppsLockMarker)
  const lockTimeout = sql.indexOf(lockTimeoutLiteral, finalLockBlock)
  const lockTablesIndex = sql.indexOf(lockTables, finalLockBlock)
  const fkDropIndex = sql.indexOf(fkDrop, finalLockBlock)
  const firstAppsTrigger = sql.search(/DROP TRIGGER IF EXISTS \w+ ON public\.apps/)

  expect(begin).toBeGreaterThan(0)
  expect(commit).toBeGreaterThan(begin)
  expect(finalLockBlock).toBeGreaterThan(begin)
  expect(lockTimeout).toBeGreaterThan(finalLockBlock)
  expect(lockTablesIndex).toBeGreaterThan(lockTimeout)
  expect(fkDropIndex).toBeGreaterThan(lockTablesIndex)
  expect(firstAppsTrigger).toBeGreaterThan(fkDropIndex)
  expect(commit).toBeGreaterThan(firstAppsTrigger)
  expect(lockListsAppVersionsBeforeApps(sql)).toBe(true)

  const preFinalLock = sql.slice(0, finalLockBlock)
  const beforeAppsTriggers = sql.slice(0, sql.search(
    /DROP TRIGGER IF EXISTS \w+ ON public\.apps/,
  ))

  expect(preFinalLock).not.toMatch(/LOCK TABLE public\.(apps|app_versions)/)
  expect(preFinalLock).not.toContain(fkDrop)
  expect(preFinalLock).not.toMatch(/ALTER TABLE public\.apps\b/)
  expect(preFinalLock).not.toMatch(
    /CREATE (UNIQUE )?INDEX[\s\S]* ON public\.app_versions\b/,
  )
  expect(beforeAppsTriggers).not.toMatch(
    /DROP TRIGGER IF EXISTS \w+ ON public\.(apps|app_versions)/,
  )
  expect(beforeAppsTriggers).not.toMatch(
    /CREATE TRIGGER[\s\S]* ON public\.(apps|app_versions)/,
  )

  for (const match of sql.matchAll(/SET LOCAL lock_timeout = '([^']+)'/g)) {
    expect(match[1]).toBe('500ms')
  }
}

describe('storage gb-hours billing migration lock order', () => {
  it('uses one atomic transaction with 500ms locks before apps/app_versions DDL', () => {
    assertMigrationGuards(migration)
    expect(migration).toContain(lockTimeoutLiteral)
    expect(migration).not.toMatch(/lock_timeout = '5s'/)
    expect(migration).not.toMatch(/lock_timeout = '1s'/)
  })

  it('fails the ordering check if the final lock sits after the FK drop (mutation guard)', () => {
    const finalBlockStart = migration.indexOf(finalAppsLockMarker)
    const finalBlockEnd = migration.indexOf('ALTER TABLE public.daily_storage_hourly', finalBlockStart)
    const lateLockMigration = `${migration.slice(0, finalBlockStart)}${migration.slice(finalBlockEnd)}`
      .replace(
        `${fkDrop};`,
        `${fkDrop};\n\n${lockTimeoutLiteral};\n${lockTables};\n\n`,
      )

    expect(lockPrecedesFkDrop(migration)).toBe(true)
    expect(lockPrecedesFkDrop(lateLockMigration)).toBe(false)
    expect(() => assertMigrationGuards(lateLockMigration)).toThrow()
  })

  it('fails if BEGIN/COMMIT are removed (mutation guard)', () => {
    const withoutTxn = migration.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '')
    expect(() => assertMigrationGuards(withoutTxn)).toThrow()
  })

  it('fails if lock_timeout exceeds deadlock_timeout (mutation guard)', () => {
    const slowLock = migration.replaceAll(`'500ms'`, `'5s'`)
    expect(() => assertMigrationGuards(slowLock)).toThrow()
    expect(slowLock).toMatch(/lock_timeout = '5s'/)
  })

  it('fails if apps DDL is added before the final lock block (mutation guard G)', () => {
    const poisoned = migration.replace(
      finalAppsLockMarker,
      `ALTER TABLE public.apps ADD COLUMN capgo_regression_test text;\n${finalAppsLockMarker}`,
    )
    expect(poisoned).toMatch(/ALTER TABLE public\.apps/)
    expect(() => assertMigrationGuards(poisoned)).toThrow()
  })

  it('fails if app_versions index DDL is added before the final lock block (mutation guard H)', () => {
    const poisoned = migration.replace(
      finalAppsLockMarker,
      `CREATE INDEX capgo_regression_test ON public.app_versions (id);\n${finalAppsLockMarker}`,
    )
    expect(poisoned).toMatch(/CREATE INDEX capgo_regression_test ON public\.app_versions/)
    expect(() => assertMigrationGuards(poisoned)).toThrow()
  })
})