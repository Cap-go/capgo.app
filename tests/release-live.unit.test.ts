import { describe, expect, it } from 'vitest'
import { releaseLiveTestUtils } from '../supabase/functions/_backend/private/release_live.ts'

describe('release live helpers', () => {
  it.concurrent('picks the smallest bucket that keeps the series bounded', () => {
    expect(releaseLiveTestUtils.pickBucketMinutes(30 * 60_000)).toBe(1)
    expect(releaseLiveTestUtils.pickBucketMinutes(90 * 60_000)).toBe(1)
    expect(releaseLiveTestUtils.pickBucketMinutes(3 * 60 * 60_000)).toBe(5)
    expect(releaseLiveTestUtils.pickBucketMinutes(20 * 60 * 60_000)).toBe(15)
    expect(releaseLiveTestUtils.pickBucketMinutes(72 * 60 * 60_000)).toBe(60)
  })

  it.concurrent('clamps the window to the release time, a minimum span, and 72 hours', () => {
    const now = new Date('2026-09-29T12:00:00.000Z')

    const fresh = releaseLiveTestUtils.resolveWindow('2026-09-29T11:58:00.000Z', now)
    expect(fresh.startMs).toBe(now.getTime() - 15 * 60_000)
    expect(fresh.bucketMinutes).toBe(1)
    expect(fresh.truncated).toBe(false)

    const recent = releaseLiveTestUtils.resolveWindow('2026-09-29T09:00:00.000Z', now)
    expect(recent.startMs).toBe(Date.parse('2026-09-29T09:00:00.000Z'))
    expect(recent.bucketMinutes).toBe(5)

    const old = releaseLiveTestUtils.resolveWindow('2026-09-20T00:00:00.000Z', now)
    expect(old.startMs).toBe(now.getTime() - 72 * 60 * 60_000)
    expect(old.truncated).toBe(true)

    const future = releaseLiveTestUtils.resolveWindow('2026-09-30T00:00:00.000Z', now)
    expect(future.startMs).toBe(now.getTime() - 15 * 60_000)
    expect(future.truncated).toBe(false)
  })

  it.concurrent('fills missing buckets with zeros on epoch-aligned boundaries', () => {
    const start = Date.parse('2026-09-29T10:02:00.000Z')
    const end = Date.parse('2026-09-29T10:20:00.000Z')
    const series = releaseLiveTestUtils.fillBuckets([
      { bucket: Date.parse('2026-09-29T10:05:00.000Z') / 1000, get: 4, install: '3', fail: 1 },
      { bucket: String(Date.parse('2026-09-29T10:15:00.000Z') / 1000), get: null, install: 2, fail: null },
    ], start, end, 5)

    expect(series.map(bucket => bucket.ts)).toEqual([
      '2026-09-29T10:00:00.000Z',
      '2026-09-29T10:05:00.000Z',
      '2026-09-29T10:10:00.000Z',
      '2026-09-29T10:15:00.000Z',
    ])
    expect(series[0]).toMatchObject({ get: 0, install: 0, fail: 0 })
    expect(series[1]).toMatchObject({ get: 4, install: 3, fail: 1 })
    expect(series[3]).toMatchObject({ get: 0, install: 2, fail: 0 })
  })

  it.concurrent('computes adoption against all known devices', () => {
    expect(releaseLiveTestUtils.computeAdoption({ '1.0.0': 30, '1.1.0': 70 }, '1.1.0')).toEqual({
      devices_on_release: 70,
      total_devices: 100,
      percent: 70,
    })
    expect(releaseLiveTestUtils.computeAdoption({}, '1.1.0')).toEqual({
      devices_on_release: 0,
      total_devices: 0,
      percent: null,
    })
  })

  it.concurrent('computes success rate from installs and failures', () => {
    expect(releaseLiveTestUtils.computeSuccessRate(99, 1)).toBe(99)
    expect(releaseLiveTestUtils.computeSuccessRate(0, 0)).toBeNull()
  })

  it.concurrent('escapes user input in Analytics Engine queries', () => {
    const start = Date.parse('2026-09-29T10:00:00.000Z')
    const end = Date.parse('2026-09-29T11:00:00.000Z')
    const series = releaseLiveTestUtils.buildSeriesQueryCF('com.demo\'app', '1.0.0\' OR 1=1 --', start, end, 5)
    expect(series).toContain('index1 = \'com.demo\'\'app\'')
    expect(series).toContain('blob2 = \'1.0.0\'\' OR 1=1 --\'')
    expect(series).toContain('INTERVAL \'5\' MINUTE')

    const failures = releaseLiveTestUtils.buildFailuresQueryCF('com.demo.app', '1.0.0', start, end)
    expect(failures).toContain('blob3 = \'1.0.0\'')
    expect(failures).toContain('LIKE \'%fail%\'')
  })
})
