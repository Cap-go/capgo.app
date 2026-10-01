import { describe, expect, it } from 'vitest'
import { releaseLiveTestUtils } from '../supabase/functions/_backend/private/release_live.ts'
import { lintAnalyticsEngineSql } from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'

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

    expect(series).not.toContain('blob5')

    const channelSeries = releaseLiveTestUtils.buildSeriesQueryCF('com.demo.app', '1.0.0', start, end, 5, { id: 7, name: 'prod\'uction' })
    expect(channelSeries).toContain('(blob5 = \'7\' OR (blob5 = \'\' AND blob4 = \'prod\'\'uction\'))')
    // Legacy `get` rows written before /updates recorded the channel stay visible.
    expect(channelSeries).toContain('OR (blob3 = \'get\' AND blob4 = \'\' AND blob5 = \'\')')

    const failures = releaseLiveTestUtils.buildFailuresQueryCF('com.demo.app', '1.0.0', start, end, { id: 7, name: 'prod\'uction' })
    expect(failures).toContain('blob3 = \'1.0.0\'')
    expect(failures).toContain('LIKE \'%fail%\'')
    expect(failures).toContain('AND (blob9 = \'7\' OR (blob9 = \'\' AND blob8 = \'prod\'\'uction\'))')
  })

  it.concurrent('builds the failed devices query and counts recovered vs stuck', () => {
    const start = Date.parse('2026-09-30T10:00:00.000Z')
    const end = Date.parse('2026-09-30T12:00:00.000Z')
    const query = releaseLiveTestUtils.buildFailedDevicesQueryCF('com.demo\'app', '1.0.0', start, end, { id: 7, name: 'prod\'uction' })
    expect(lintAnalyticsEngineSql(query)).toEqual([])
    expect(query).toContain('index1 = \'com.demo\'\'app\'')
    expect(query).toContain('blob3 = \'1.0.0\'')
    expect(query).toContain('GROUP BY device_id')
    // Only failures are channel scoped: set logs carry no channel.
    expect(query).toContain('(blob2 = \'set\' OR (blob2 LIKE \'%_fail\' AND (blob9 = \'7\' OR (blob9 = \'\' AND blob8 = \'prod\'\'uction\'))))')

    expect(releaseLiveTestUtils.toFailedDevices(null)).toBeNull()
    expect(releaseLiveTestUtils.toFailedDevices([])).toEqual({ total: 0, recovered: 0, stuck: 0 })
    expect(releaseLiveTestUtils.toFailedDevices([{ recovered: '8', stuck: 3 }])).toEqual({ total: 11, recovered: 8, stuck: 3 })
  })

  const prodNew = { bundle_id: 2, version_name: '1.1.0', channel_id: 1, channel_name: 'production', deployed_at: '2026-09-29T10:00:00.000Z' }
  const beta = { bundle_id: 3, version_name: '1.2.0-beta', channel_id: 2, channel_name: 'beta', deployed_at: '2026-09-29T11:00:00.000Z' }
  const prodOld = { bundle_id: 1, version_name: '1.0.0', channel_id: 1, channel_name: 'production', deployed_at: '2026-09-20T10:00:00.000Z' }
  const betaCurrent = { bundle_id: 5, version_name: '1.3.0', channel_id: 2, channel_name: 'beta', deployed_at: '2026-09-29T12:00:00.000Z' }
  const production = { id: 1, name: 'production', public: true, current: { ...prodNew } }
  const betaChannel = { id: 2, name: 'beta', public: false, current: betaCurrent }
  const staging = { id: 3, name: 'staging', public: false, current: null }
  const candidates = { channels: [betaChannel, production, staging], deployments: [beta, prodNew, prodOld] }

  it.concurrent('defaults to the public channel', () => {
    expect(releaseLiveTestUtils.pickDefaultChannel(candidates)).toBe(production)
    // No public channel: the channel with the latest deployment, then the first one.
    expect(releaseLiveTestUtils.pickDefaultChannel({ channels: [staging, betaChannel], deployments: [beta] })).toBe(betaChannel)
    expect(releaseLiveTestUtils.pickDefaultChannel({ channels: [staging, betaChannel], deployments: [] })).toBe(staging)
    expect(releaseLiveTestUtils.pickDefaultChannel({ channels: [], deployments: [] })).toBeNull()
  })

  it.concurrent('picks the requested channel, else the default one', () => {
    expect(releaseLiveTestUtils.pickChannel(candidates)).toBe(production)
    expect(releaseLiveTestUtils.pickChannel(candidates, 2)).toBe(betaChannel)
    expect(releaseLiveTestUtils.pickChannel(candidates, 99)).toBe(production)
    // Version-only links open the channel that received that version.
    expect(releaseLiveTestUtils.pickChannel(candidates, undefined, '1.0.0')).toBe(production)
    expect(releaseLiveTestUtils.pickChannel(candidates, undefined, '1.2.0-beta')).toBe(betaChannel)
    expect(releaseLiveTestUtils.pickChannel(candidates, undefined, '1.3.0')).toBe(betaChannel)
    expect(releaseLiveTestUtils.pickChannel(candidates, undefined, 'missing')).toBe(production)
  })

  it.concurrent('picks the release inside the channel', () => {
    expect(releaseLiveTestUtils.pickRelease(candidates, production)).toEqual(prodNew)
    expect(releaseLiveTestUtils.pickRelease(candidates, production, '1.0.0')).toEqual(prodOld)
    expect(releaseLiveTestUtils.pickRelease(candidates, production, '1.2.0-beta')).toBeNull()
    expect(releaseLiveTestUtils.pickRelease(candidates, betaChannel)).toEqual(beta)
    // No deploy history on the channel: the bundle it serves now.
    expect(releaseLiveTestUtils.pickRelease({ ...candidates, deployments: [] }, betaChannel)).toBe(betaCurrent)
    expect(releaseLiveTestUtils.pickRelease(candidates, staging)).toBeNull()
  })

  it.concurrent('lists channels and only the selected channel deployments', () => {
    const context = releaseLiveTestUtils.toChannelContext(candidates, betaChannel)
    expect(context.channel).toEqual({ id: 2, name: 'beta', is_default: false })
    expect(context.channels).toEqual([
      { id: 2, name: 'beta', is_default: false },
      { id: 1, name: 'production', is_default: true },
      { id: 3, name: 'staging', is_default: false },
    ])
    expect(context.recent_deployments).toEqual([
      { version_name: '1.2.0-beta', channel_id: 2, channel_name: 'beta', deployed_at: beta.deployed_at },
    ])
    expect(releaseLiveTestUtils.toChannelContext({ channels: [], deployments: [] }, null)).toEqual({ channel: null, channels: [], recent_deployments: [] })
  })
})
