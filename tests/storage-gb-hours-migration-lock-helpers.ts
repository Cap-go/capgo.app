import { readFileSync } from 'node:fs'

export const STORAGE_MIGRATION_PATH = new URL(
  '../supabase/migrations/20261119233941_storage_gb_hours_billing.sql',
  import.meta.url,
)

export function readStorageGbHoursMigrationSql() {
  return readFileSync(STORAGE_MIGRATION_PATH, 'utf8')
}

/** Mutation guard: run DSH table lock before apps/FK (inverts production order). */
export function invertStorageMigrationLockOrder(sql: string): string {
  const appsMarker = '-- 0. Apps / app_versions before any daily_storage_hourly writer path'
  const section1Marker = '-- 1. Byte-hours of deleted apps stay billable until delete_old_deleted_apps'
  const appsStart = sql.indexOf(appsMarker)
  const section1Start = sql.indexOf(section1Marker)
  const dshLockEnd = sql.indexOf('$capgo_lock_daily_storage_hourly$;', section1Start)
  if (appsStart < 0 || section1Start < 0 || dshLockEnd < 0)
    throw new Error('storage migration lock markers missing')
  const dshLockEndPos = dshLockEnd + '$capgo_lock_daily_storage_hourly$;'.length

  const appsBlock = sql.slice(appsStart, section1Start)
  const head = sql.slice(0, appsStart)
  const section1AndDshLock = sql.slice(section1Start, dshLockEndPos)
  const tail = sql.slice(dshLockEndPos)

  return `${head}${section1AndDshLock}${appsBlock}${tail}`
}