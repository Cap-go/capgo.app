import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, expect, it } from 'vitest'
import { buildWeeklyEmailMetadata, computeWeeklyInstallStats, getWeeklyReportRange, WEEKLY_REPORT_SQL } from '../supabase/functions/_backend/utils/cron_email_stats.ts'
import { POSTGRES_URL } from './test-utils.ts'

const pool = new Pool({ connectionString: POSTGRES_URL, max: 2 })
afterAll(async () => pool.end())

it.concurrent('reports one app across bundles over exactly seven completed UTC dates', async () => {
  const db = await pool.connect()
  const appId = `com.example.weekly.${randomUUID()}`
  const range = getWeeklyReportRange(new Date('2026-01-03T12:30:00Z'))
  try {
    await db.query('BEGIN')
    await db.query(`INSERT INTO public.daily_version (app_id, date, version_name, get, install, fail) VALUES
      ($1, '2025-12-26', '1.0.0', 999999, 999, 999),
      ($1, '2025-12-27', '1.0.0', 1000000, 10, 1),
      ($1, '2026-01-02', '1.0.0', 200000, 20, 2),
      ($1, '2026-01-02', '2.0.0', 300000, 30, 3),
      ($1, '2026-01-03', '2.0.0', 999999, 999, 999),
      ($2, '2026-01-02', '1.0.0', 999999, 999, 999)`, [appId, `${appId}.other`])
    const { rows } = await db.query(WEEKLY_REPORT_SQL, [appId, range.start, range.end])
    expect(rows).toEqual([{ all_updates: '60', failed_updates: '6', update_checks: '1500000' }])
    const metadata = buildWeeklyEmailMetadata(appId, computeWeeklyInstallStats(rows[0]), range)
    expect(metadata).toMatchObject({ window_start: '2025-12-27', window_end: '2026-01-03', weekly_install: '60', weekly_fail: '6', weekly_update_checks_formatted: '1,500,000' })
    const empty = await db.query(WEEKLY_REPORT_SQL, [`${appId}.empty`, range.start, range.end])
    expect(computeWeeklyInstallStats(empty.rows[0])).toEqual({ successfulInstalls: 0, failedUpdates: 0, updateChecks: 0 })
  }
  finally {
    await db.query('ROLLBACK')
    db.release()
  }
})
