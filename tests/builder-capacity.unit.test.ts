import { describe, expect, it } from 'vitest'
import {
  maxConcurrentUsed,
  reconstructHourlyCapacity,
  workersAt,
} from '../supabase/functions/_backend/utils/builder_capacity.ts'

describe('builder capacity reconstruction', () => {
  it.concurrent('workersAt uses the latest event at or before the timestamp', () => {
    const events = [
      { created_at: Date.parse('2026-08-06T10:00:00.000Z'), workers_total: 2, delta: 2 },
      { created_at: Date.parse('2026-08-06T12:00:00.000Z'), workers_total: 3, delta: 1 },
      { created_at: Date.parse('2026-08-06T14:00:00.000Z'), workers_total: 1, delta: -2 },
    ]
    expect(workersAt(events, Date.parse('2026-08-06T09:59:59.000Z'))).toBe(0)
    expect(workersAt(events, Date.parse('2026-08-06T10:00:00.000Z'))).toBe(2)
    expect(workersAt(events, Date.parse('2026-08-06T12:30:00.000Z'))).toBe(3)
    expect(workersAt(events, Date.parse('2026-08-06T15:00:00.000Z'))).toBe(1)
  })

  it.concurrent('maxConcurrentUsed counts overlapping runs inside an hour', () => {
    const hourStart = Date.parse('2026-08-06T10:00:00.000Z')
    const hourEnd = Date.parse('2026-08-06T11:00:00.000Z')
    const used = maxConcurrentUsed([
      { started_at: Date.parse('2026-08-06T09:50:00.000Z'), completed_at: Date.parse('2026-08-06T10:20:00.000Z') },
      { started_at: Date.parse('2026-08-06T10:10:00.000Z'), completed_at: Date.parse('2026-08-06T10:40:00.000Z') },
      { started_at: Date.parse('2026-08-06T10:30:00.000Z'), completed_at: Date.parse('2026-08-06T11:10:00.000Z') },
    ], hourStart, hourEnd)
    // 10:10-10:20: 2 concurrent, 10:30-10:40: 2 concurrent
    expect(used).toBe(2)
  })

  it.concurrent('reconstructHourlyCapacity builds free = workers - used', () => {
    const hourly = reconstructHourlyCapacity(
      [
        { created_at: Date.parse('2026-08-06T09:00:00.000Z'), workers_total: 3, delta: 3 },
      ],
      [
        { started_at: Date.parse('2026-08-06T10:05:00.000Z'), completed_at: Date.parse('2026-08-06T10:50:00.000Z') },
        { started_at: Date.parse('2026-08-06T10:20:00.000Z'), completed_at: Date.parse('2026-08-06T10:45:00.000Z') },
      ],
      '2026-08-06T10:00:00.000Z',
      '2026-08-06T12:00:00.000Z',
    )
    expect(hourly).toHaveLength(2)
    expect(hourly[0]).toMatchObject({
      date: '2026-08-06T10:00:00.000Z',
      workers: 3,
      used: 2,
      free: 1,
    })
    expect(hourly[1]).toMatchObject({
      date: '2026-08-06T11:00:00.000Z',
      workers: 3,
      used: 0,
      free: 3,
    })
  })
})
