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
    // Per device: earliest failure and latest install of this version.
    expect(query).toContain('min(if(blob2 = \'set\', 4102444800, toUnixTimestamp(timestamp))) AS first_fail')
    expect(query).toContain('max(if(blob2 = \'set\', toUnixTimestamp(timestamp), 0)) AS last_set')
    // Recovered = installed at or after the first failure, stuck otherwise; devices without failure are dropped.
    expect(query).toContain('sum(if(last_set >= first_fail, 1, 0)) AS recovered')
    expect(query).toContain('sum(if(last_set >= first_fail, 0, 1)) AS stuck')
    expect(query).toContain('WHERE first_fail < 4102444800')
    // Only failures are channel scoped: set logs carry no channel.
    expect(query).toContain('(blob2 = \'set\' OR ((blob2 LIKE \'%_fail\' OR blob2 IN (\'insufficient_disk_space\', \'cannotGetBundle\', \'blocked_by_server_url\', \'backend_refusal\')) AND (blob9 = \'7\' OR (blob9 = \'\' AND blob8 = \'prod\'\'uction\'))))')

    // The Postgres fallback must keep the same rules.
    const sb = releaseLiveTestUtils.FAILED_DEVICES_QUERY_SB
    expect(sb).toContain('min(date_trunc(\'second\', s.created_at)) FILTER (WHERE s.action <> \'set\') AS first_fail')
    expect(sb).toContain('max(date_trunc(\'second\', s.created_at)) FILTER (WHERE s.action = \'set\') AS last_set')
    expect(sb).toContain('count(*) FILTER (WHERE d.last_set >= d.first_fail) AS recovered')
    expect(sb).toContain('count(*) FILTER (WHERE d.last_set IS NULL OR d.last_set < d.first_fail) AS stuck')
    expect(sb).toContain('(s.action::text LIKE \'%\\_fail\' OR s.action::text = ANY($6::text[]))')
    // Channel scope sits inside the failure branch only.
    expect(sb.indexOf('EXISTS')).toBeGreaterThan(sb.indexOf('ANY($6::text[])'))
    expect(sb).toContain('s.action = \'set\'\n      OR (')
    expect(sb).toContain('WHERE d.first_fail IS NOT NULL')
    expect(releaseLiveTestUtils.EXTRA_FAILURE_ACTIONS).toEqual(['insufficient_disk_space', 'cannotGetBundle', 'blocked_by_server_url', 'backend_refusal'])

    expect(releaseLiveTestUtils.toFailedDevices(null)).toBeNull()
    expect(releaseLiveTestUtils.toFailedDevices([])).toEqual({ total: 0, recovered: 0, stuck: 0 })
    expect(releaseLiveTestUtils.toFailedDevices([{ recovered: '8', stuck: 3 }])).toEqual({ total: 11, recovered: 8, stuck: 3 })
  })

  const prodNew = { bundle_id: 2, version_name: '1.1.0', channel_id: 1, channel_name: 'production', deployed_at: '2026-09-29T10:00:00.000Z' }
  const beta = { bundle_id: 3, version_name: '1.2.0-beta', channel_id: 2, channel_name: 'beta', deployed_at: '2026-09-29T11:00:00.000Z' }
  const prodOld = { bundle_id: 1, version_name: '1.0.0', channel_id: 1, channel_name: 'production', deployed_at: '2026-09-20T10:00:00.000Z' }
  const betaCurrent = { bundle_id: 5, version_name: '1.3.0', channel_id: 2, channel_name: 'beta', deployed_at: '2026-09-29T12:00:00.000Z' }
  const production = { id: 1, name: 'production', public: true, current: { ...prodNew }, rollout: null }
  const betaChannel = { id: 2, name: 'beta', public: false, current: betaCurrent, rollout: null }
  const staging = { id: 3, name: 'staging', public: false, current: null, rollout: null }
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

  const rolloutTarget = { bundle_id: 9, version_name: '1.2.0', channel_id: 1, channel_name: 'production', deployed_at: '2026-09-29T13:00:00.000Z' }
  const rolloutProduction = {
    ...production,
    rollout: { target: rolloutTarget, percentage_bps: 2500, paused_at: null, pause_reason: null },
  }
  const rolloutCandidates = { channels: [betaChannel, rolloutProduction, staging], deployments: [beta, prodNew, prodOld] }

  it.concurrent('watches the progressive rollout target, not the last full deployment', () => {
    expect(releaseLiveTestUtils.pickRelease(rolloutCandidates, rolloutProduction)).toEqual(rolloutTarget)
    expect(releaseLiveTestUtils.pickRelease(rolloutCandidates, rolloutProduction, '1.2.0')).toEqual(rolloutTarget)
    // Naming another bundle still opens it.
    expect(releaseLiveTestUtils.pickRelease(rolloutCandidates, rolloutProduction, '1.0.0')).toEqual(prodOld)
    // The target leads the release picker of its channel.
    const context = releaseLiveTestUtils.toChannelContext(rolloutCandidates, rolloutProduction)
    expect(context.recent_deployments[0]).toMatchObject({ version_name: '1.2.0', channel_name: 'production' })
    expect(context.recent_deployments.map(deployment => deployment.version_name)).toEqual(['1.2.0', '1.1.0', '1.0.0'])
  })

  it.concurrent('measures rollout reach against the targeted share of devices', () => {
    const rollout = releaseLiveTestUtils.computeRollout(
      rolloutProduction.rollout,
      prodNew,
      { '1.2.0': 20, '1.1.0': 70, '1.0.0': 10 },
      { install: 990, fail: 10 },
    )
    expect(rollout).toEqual({
      target_version: '1.2.0',
      fallback_version: '1.1.0',
      fallback_bundle_id: 2,
      percentage: 25,
      status: 'running',
      paused_at: null,
      pause_reason: null,
      devices_on_target: 20,
      devices_on_fallback: 70,
      total_devices: 100,
      expected_on_target: 25,
      reach_percent: 80,
      fallback_totals: { install: 990, fail: 10, success_rate: 99 },
    })

    const paused = releaseLiveTestUtils.computeRollout(
      { ...rolloutProduction.rollout, paused_at: '2026-09-29T14:00:00.000Z', pause_reason: 'auto' },
      null,
      {},
      null,
    )
    expect(paused).toMatchObject({ status: 'paused', total_devices: 0, expected_on_target: 0, reach_percent: null, fallback_totals: null })
    expect(releaseLiveTestUtils.computeRollout({ ...rolloutProduction.rollout, percentage_bps: 0 }, prodNew, { '1.1.0': 5 }, null).status).toBe('zero')
    // Reach is capped: sticky devices from an earlier, wider rollout can exceed the share.
    expect(releaseLiveTestUtils.computeRollout(rolloutProduction.rollout, prodNew, { '1.2.0': 60, '1.1.0': 40 }, null).reach_percent).toBe(100)
  })
})
