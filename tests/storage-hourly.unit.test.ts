import { describe, expect, it } from 'vitest'
import { appStorageOwnership, calculateStorageHourlyRows } from '../supabase/functions/_backend/triggers/cron_stat_app.ts'

const APP_ID = 'com.storage-hourly.test'
const OWNER_ORG = '11111111-2222-4333-8444-555555555555'

function calculate(events: Parameters<typeof calculateStorageHourlyRows>[0], currentHour: string) {
  return calculateStorageHourlyRows(events, {
    appId: APP_ID,
    ownerOrg: OWNER_ORG,
    cycleStart: '2026-01-01T00:00:00.000Z',
    cycleEnd: '2026-02-01T00:00:00.000Z',
    currentHour,
  }).rows.map(row => ({
    date: row.date,
    storage_byte_hours: row.storage_byte_hours,
  }))
}

describe('calculateStorageHourlyRows', () => {
  it('records one byte-hour per active byte for full hours', () => {
    expect(calculate([
      { version_id: 1, size: 100, timestamp: '2026-01-01T00:00:00.000Z' },
    ], '2026-01-01T03:00:00.000Z')).toEqual([
      { date: '2026-01-01', storage_byte_hours: 300 },
    ])
  })

  it('uses partial-hour precision for additions and removals', () => {
    expect(calculate([
      { version_id: 1, size: 120, timestamp: '2026-01-01T00:30:00.000Z' },
      { version_id: 1, size: -120, timestamp: '2026-01-01T02:15:00.000Z' },
    ], '2026-01-01T04:00:00.000Z')).toEqual([
      { date: '2026-01-01', storage_byte_hours: 210 },
    ])
  })

  it('clips versions that started before the billing cycle', () => {
    expect(calculate([
      { version_id: 1, size: 200, timestamp: '2025-12-31T23:00:00.000Z' },
      { version_id: 1, size: -200, timestamp: '2026-01-01T01:30:00.000Z' },
    ], '2026-01-01T03:00:00.000Z')).toEqual([
      { date: '2026-01-01', storage_byte_hours: 300 },
    ])
  })

  it('splits byte-hours across UTC days', () => {
    expect(calculate([
      { version_id: 1, size: 100, timestamp: '2026-01-01T23:30:00.000Z' },
      { version_id: 1, size: -100, timestamp: '2026-01-02T01:15:00.000Z' },
    ], '2026-01-02T03:00:00.000Z')).toEqual([
      { date: '2026-01-01', storage_byte_hours: 50 },
      { date: '2026-01-02', storage_byte_hours: 125 },
    ])
  })

  it('tags every row with the UTC day its billing cycle started', () => {
    const rows = calculateStorageHourlyRows([
      { version_id: 1, size: 100, timestamp: '2026-01-10T00:00:00.000Z' },
    ], {
      appId: APP_ID,
      ownerOrg: OWNER_ORG,
      cycleStart: '2026-01-15T12:00:00.000Z',
      cycleEnd: '2026-02-15T12:00:00.000Z',
      currentHour: '2026-01-16T12:00:00.000Z',
    }).rows

    // The boundary day only holds this cycle's afternoon; the previous cycle keeps its morning row.
    expect(rows.map(row => [row.cycle_start, row.date, row.storage_byte_hours])).toEqual([
      ['2026-01-15', '2026-01-15', 1200],
      ['2026-01-15', '2026-01-16', 1200],
    ])
    expect(rows.every(row => row.owner_org === OWNER_ORG)).toBe(true)
  })

  it('only counts hours after the current owner got the app', () => {
    const rows = calculateStorageHourlyRows([
      { version_id: 1, size: 100, timestamp: '2026-01-01T00:00:00.000Z' },
    ], {
      appId: APP_ID,
      ownerOrg: OWNER_ORG,
      cycleStart: '2026-01-01T00:00:00.000Z',
      cycleEnd: '2026-02-01T00:00:00.000Z',
      currentHour: '2026-01-03T00:00:00.000Z',
      // Transferred to this org at noon on the 2nd: the former owner keeps the earlier hours.
      accrualStart: '2026-01-02T12:00:00.000Z',
    }).rows

    expect(rows.map(row => [row.cycle_start, row.date, row.storage_byte_hours])).toEqual([
      ['2026-01-01', '2026-01-02', 1200],
    ])
  })

  it('stamps rows with the time the refresh started, not the time it finished', () => {
    const rows = calculateStorageHourlyRows([
      { version_id: 1, size: 100, timestamp: '2026-01-01T00:00:00.000Z' },
    ], {
      appId: APP_ID,
      ownerOrg: OWNER_ORG,
      cycleStart: '2026-01-01T00:00:00.000Z',
      cycleEnd: '2026-02-01T00:00:00.000Z',
      currentHour: '2026-01-01T03:00:00.000Z',
      writtenAt: '2026-01-01T03:00:05.000Z',
    }).rows

    expect(rows.map(row => row.updated_at)).toEqual(['2026-01-01T03:00:05.000Z'])
  })

  it('derives every ownership segment from the transfer history', () => {
    expect(appStorageOwnership({
      owner_org: 'org-c',
      created_at: '2026-01-01T00:00:00.000Z',
      transfer_history: [
        { transferred_at: '2026-03-01T00:00:00.000Z', transferred_from: 'org-b', transferred_to: 'org-c' },
        { transferred_at: '2026-02-01T00:00:00.000Z', transferred_from: 'org-a', transferred_to: 'org-b' },
      ],
    })).toEqual({
      ownedSince: '2026-03-01T00:00:00.000Z',
      formerOwners: [
        { orgId: 'org-a', ownedSince: '2026-01-01T00:00:00.000Z', transferredAt: '2026-02-01T00:00:00.000Z' },
        { orgId: 'org-b', ownedSince: '2026-02-01T00:00:00.000Z', transferredAt: '2026-03-01T00:00:00.000Z' },
      ],
    })
  })

  it('keeps an org that owned the app twice as two segments', () => {
    expect(appStorageOwnership({
      owner_org: 'org-a',
      created_at: '2026-01-01T00:00:00.000Z',
      transfer_history: [
        { transferred_at: '2026-02-01T00:00:00.000Z', transferred_from: 'org-a', transferred_to: 'org-b' },
        { transferred_at: '2026-03-01T00:00:00.000Z', transferred_from: 'org-b', transferred_to: 'org-a' },
      ],
    })).toEqual({
      ownedSince: '2026-03-01T00:00:00.000Z',
      formerOwners: [
        { orgId: 'org-a', ownedSince: '2026-01-01T00:00:00.000Z', transferredAt: '2026-02-01T00:00:00.000Z' },
        { orgId: 'org-b', ownedSince: '2026-02-01T00:00:00.000Z', transferredAt: '2026-03-01T00:00:00.000Z' },
      ],
    })
  })
})
