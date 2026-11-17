import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  calculateStorageHourlyRows,
  calculateStorageHourlyRowsFromLifetimes,
  VERSION_STORAGE_LIFETIMES_SQL,
  versionStorageLifetimesFromRows,
} from '../supabase/functions/_backend/triggers/cron_stat_app.ts'
import { executeSQL } from './test-utils.ts'

// cron_stat_app used to select every version_meta row of an app and fold them
// in JS. It now folds them in SQL and skips bundles removed before the cycle.
// Both paths must give the same storage rows and skip counts.

const appId = `com.storage.lifetimes.${randomUUID().slice(0, 8)}`
const ownerOrg = randomUUID()
const cycleStart = '2026-03-01T00:00:00.000Z'
const cycleEnd = '2026-04-01T00:00:00.000Z'
const currentHour = '2026-03-20T05:00:00.000Z'

interface MetaRow {
  timestamp: string
  version_id: number
  size: number
  lifetime?: number
}

const rows: MetaRow[] = [
  // Removed long before the cycle: dropped by the SQL fold, skipped by JS.
  { version_id: 1, size: 100, timestamp: '2025-01-01T00:00:00Z' },
  { version_id: 1, size: -100, timestamp: '2025-02-01T00:00:00Z' },
  // Removed less than a day before the cycle: kept by the margin, outside the cycle.
  { version_id: 2, size: 200, timestamp: '2026-02-01T00:00:00Z' },
  { version_id: 2, size: -200, timestamp: '2026-02-28T12:00:00Z' },
  // Added before the cycle, still alive.
  { version_id: 3, size: 300, timestamp: '2026-01-15T00:00:00Z' },
  // Added and removed inside the cycle.
  { version_id: 4, size: 400, timestamp: '2026-03-02T10:30:00Z' },
  { version_id: 4, size: -400, timestamp: '2026-03-05T08:15:00Z' },
  // Removal only: counted as missing addition.
  { version_id: 5, size: -500, timestamp: '2026-03-03T00:00:00Z' },
  // Zero-size row only: counted as missing addition.
  { version_id: 6, size: 0, timestamp: '2026-03-04T00:00:00Z' },
  // Removed before it was added: invalid interval.
  { version_id: 7, size: -700, timestamp: '2026-03-06T00:00:00Z' },
  { version_id: 7, size: 700, timestamp: '2026-03-07T00:00:00Z' },
  // Removal only, long before the cycle: still a missing addition.
  { version_id: 8, size: -800, timestamp: '2024-06-01T00:00:00Z' },
  // Added after the calculation end: not read by either path.
  { version_id: 9, size: 900, timestamp: '2026-03-25T00:00:00Z' },
  // Added inside the cycle, removed after the calculation end.
  { version_id: 10, size: 1000, timestamp: '2026-03-10T00:00:00Z' },
  { version_id: 10, size: -1000, timestamp: '2026-03-28T00:00:00Z' },
  // Deleted, then restored: billed in both stored intervals, not while deleted.
  { version_id: 11, size: 1100, timestamp: '2026-03-01T00:00:00Z', lifetime: 0 },
  { version_id: 11, size: -1100, timestamp: '2026-03-04T00:00:00Z', lifetime: 0 },
  { version_id: 11, size: 1100, timestamp: '2026-03-08T00:00:00Z', lifetime: 1 },
]

const options = { appId, ownerOrg, cycleStart, cycleEnd, currentHour }

function withoutUpdatedAt(result: ReturnType<typeof calculateStorageHourlyRows>) {
  return {
    ...result,
    rows: result.rows.map(({ updated_at: _updatedAt, ...row }) => row),
  }
}

describe('cron_stat_app storage lifetimes SQL fold', () => {
  afterAll(async () => {
    await executeSQL('DELETE FROM public.version_meta WHERE app_id = $1', [appId])
  })

  it('matches the JS fold of every version_meta row', async () => {
    await executeSQL(
      `INSERT INTO public.version_meta (app_id, version_id, size, timestamp, lifetime)
        SELECT $1, r.version_id, r.size, r.timestamp, r.lifetime
        FROM jsonb_to_recordset($2::jsonb) AS r(version_id bigint, size bigint, timestamp timestamp, lifetime integer)`,
      [appId, JSON.stringify(rows.map(row => ({ ...row, lifetime: row.lifetime ?? 0, timestamp: row.timestamp.replace('Z', '') })))],
    )

    // Previous query: every row of the app before the calculation end.
    const events = await executeSQL<MetaRow>(
      `SELECT timestamp, version_id, size, lifetime FROM public.version_meta
        WHERE app_id = $1 AND timestamp < $2::timestamp
        ORDER BY version_id, timestamp`,
      [appId, currentHour],
    )
    const expected = calculateStorageHourlyRows(events, options)

    const lifetimeRows = await executeSQL(VERSION_STORAGE_LIFETIMES_SQL, [appId, currentHour, cycleStart])
    const actual = calculateStorageHourlyRowsFromLifetimes(versionStorageLifetimesFromRows(lifetimeRows), options)

    expect(withoutUpdatedAt(actual)).toEqual(withoutUpdatedAt(expected))
    expect(expected.rows.length).toBeGreaterThan(0)
    expect(expected.skippedMissingAddition).toBe(3)
    expect(expected.skippedInvalidInterval).toBe(1)

    // Bundles 1 (removed a year before the cycle) and 9 (after the end) are not returned.
    const returnedVersions = lifetimeRows.map(row => Number(row.version_id)).sort((a, b) => a - b)
    expect(returnedVersions).toEqual([2, 3, 4, 5, 6, 7, 8, 10, 11, 11])

    // The restored bundle: 3 days before its deletion, then from the restore to the calculation end.
    const restored = calculateStorageHourlyRows(events.filter(event => Number(event.version_id) === 11), options)
    const restoredByteHours = restored.rows.reduce((sum, row) => sum + Number(row.storage_byte_hours), 0)
    expect(restoredByteHours).toBe(1100 * (3 * 24 + 12 * 24 + 5))
  })
})
