import { describe, expect, it } from 'vitest'
import {
  applyBuildStreamMessage,
  buildTimeline,
  createBuildLiveState,
  LOG_TAIL_LIMIT,
  resolveBuildOutcome,
  stepCopy,
} from '../src/services/buildLiveStream'

function feed(messages: unknown[]) {
  return messages.reduce(applyBuildStreamMessage, createBuildLiveState())
}

function step(id: number, action: string, status: string, extra: Record<string, unknown> = {}) {
  return { type: 'custom_msg', id, kind: 'step', data: { action, status, ts: 1_000 * id, ...extra } }
}

describe('applyBuildStreamMessage', () => {
  it('keeps a bounded log tail and tracks the last id', () => {
    const lines = Array.from({ length: LOG_TAIL_LIMIT + 5 }, (_, i) => ({ type: 'log', id: i + 1, message: `line ${i}` }))
    const state = feed(lines)
    expect(state.logs).toHaveLength(LOG_TAIL_LIMIT)
    expect(state.logs.at(-1)).toBe(`line ${LOG_TAIL_LIMIT + 4}`)
    expect(state.lastId).toBe(LOG_TAIL_LIMIT + 5)
  })

  it('ignores replayed ids, heartbeats and malformed payloads', () => {
    const state = feed([
      { type: 'log', id: 1, message: 'a' },
      { type: 'log', id: 1, message: 'a' },
      { type: 'heartbeat_response', status: 'ok' },
      null,
      'garbage',
      { type: 'log', id: 2 },
      { type: 'status', id: 3 },
      { type: 'custom_msg', id: 4, kind: 'step', data: { action: 42, status: 'started' } },
    ])
    expect(state.logs).toEqual(['a'])
    expect(state.steps).toEqual([])
    expect(state.status).toBeNull()
  })

  it('expands batch_messages', () => {
    const state = feed([{ type: 'batch_messages', messages: [{ type: 'log', id: 1, message: 'a' }, { type: 'log', id: 2, message: 'b' }] }])
    expect(state.logs).toEqual(['a', 'b'])
    expect(state.lastId).toBe(2)
  })

  it('tracks step lifecycle and stays idempotent when steps are replayed', () => {
    const state = feed([
      step(1, 'android_sdk_setup', 'started'),
      step(2, 'android_sdk_setup', 'succeeded', { duration_ms: 4_000 }),
      step(3, 'android_aab_build', 'started'),
      // Replay on reconnect: same step without an id must not duplicate it.
      { type: 'custom_msg', kind: 'step', data: { action: 'android_sdk_setup', status: 'succeeded', duration_ms: 4_000, ts: 2_000 } },
      step(4, 'unknown_thing', 'noop'),
    ])
    expect(state.steps).toEqual([
      { action: 'android_sdk_setup', status: 'succeeded', startedAt: 1_000, durationMs: 4_000 },
      { action: 'android_aab_build', status: 'running', startedAt: 3_000 },
    ])
  })

  it('stores only http(s) download links', () => {
    expect(feed([{ type: 'custom_msg', id: 1, kind: 'qr_download_link', data: { url: 'https://dl.example.com/app.apk' } }]).downloadUrl)
      .toBe('https://dl.example.com/app.apk')
    expect(feed([{ type: 'custom_msg', id: 1, kind: 'qr_download_link', data: { url: 'javascript:alert(1)' } }]).downloadUrl)
      .toBeNull()
  })

  it('records status and ignores logs after a terminal status', () => {
    const state = feed([
      { type: 'status', id: 1, status: 'RUNNING' },
      { type: 'status', id: 2, status: 'failed', message: 'Gradle failed' },
      { type: 'log', id: 3, message: 'cleanup' },
    ])
    expect(state.status).toBe('failed')
    expect(state.statusMessage).toBe('Gradle failed')
    expect(state.logs).toEqual([])
  })
})

describe('resolveBuildOutcome', () => {
  it('prefers a terminal stream status over a lagging database row', () => {
    expect(resolveBuildOutcome('succeeded', 'running')).toBe('success')
    expect(resolveBuildOutcome('failed', 'running')).toBe('failure')
  })

  it('falls back to the database status', () => {
    expect(resolveBuildOutcome(null, 'released')).toBe('success')
    expect(resolveBuildOutcome('running', 'expired')).toBe('failure')
    expect(resolveBuildOutcome(null, 'pending')).toBeNull()
  })
})

describe('buildTimeline', () => {
  const live = createBuildLiveState()

  it('shows the upload phase while the request is pending', () => {
    const timeline = buildTimeline({ live, dbStatus: 'pending', machineStarted: false, platform: 'android' })
    expect(timeline.rows.map(r => [r.key, r.state])).toEqual([
      ['upload', 'running'],
      ['machine', 'pending'],
      ['build', 'pending'],
    ])
    expect(timeline.current).toBe(0)
    expect(timeline.progress).toBe(0)
  })

  it('waits for a machine, then builds in status-only mode', () => {
    expect(buildTimeline({ live, dbStatus: 'running', machineStarted: false, platform: 'ios' }).rows.map(r => r.state))
      .toEqual(['done', 'running', 'pending'])
    const building = buildTimeline({ live, dbStatus: 'running', machineStarted: true, platform: 'ios' })
    expect(building.rows.map(r => r.state)).toEqual(['done', 'done', 'running'])
    expect(building.current).toBe(2)
  })

  it('lists live steps followed by the platform milestones not seen yet', () => {
    const state = feed([
      step(1, 'project_bundle_download', 'started'),
      step(2, 'project_bundle_download', 'succeeded', { duration_ms: 2_000 }),
      step(3, 'android_sdk_setup', 'started'),
    ])
    const timeline = buildTimeline({ live: state, dbStatus: 'running', machineStarted: true, platform: 'android' })
    expect(timeline.rows.map(r => [r.key, r.state])).toEqual([
      ['upload', 'done'],
      ['machine', 'done'],
      ['project_bundle_download', 'done'],
      ['android_sdk_setup', 'running'],
      ['android_signing_prepare', 'pending'],
      ['android_aab_build', 'pending'],
      ['google_play_upload', 'pending'],
    ])
    expect(timeline.current).toBe(3)
    expect(timeline.progress).toBeCloseTo(3 / 7)
  })

  it('points at the next step between two steps', () => {
    const state = feed([step(1, 'project_bundle_download', 'started'), step(2, 'project_bundle_download', 'succeeded')])
    const timeline = buildTimeline({ live: state, dbStatus: 'running', machineStarted: true, platform: 'android' })
    expect(timeline.rows[timeline.current].key).toBe('android_sdk_setup')
  })

  it('marks the running step as failed when the build fails', () => {
    const state = feed([step(1, 'ios_archive_build', 'started'), { type: 'status', id: 2, status: 'failed' }])
    const timeline = buildTimeline({ live: state, dbStatus: 'running', machineStarted: true, platform: 'ios' })
    const failed = timeline.rows.find(r => r.state === 'failed')
    expect(failed?.key).toBe('ios_archive_build')
    expect(timeline.current).toBe(timeline.rows.indexOf(failed!))
  })

  it('fails the build phase in status-only mode', () => {
    const timeline = buildTimeline({ live, dbStatus: 'failed', machineStarted: true, platform: 'android' })
    expect(timeline.rows.map(r => r.state)).toEqual(['done', 'done', 'failed'])
  })

  it('completes every row on success', () => {
    const timeline = buildTimeline({ live, dbStatus: 'succeeded', machineStarted: true, platform: 'android' })
    expect(timeline.rows.every(r => r.state === 'done')).toBe(true)
    expect(timeline.progress).toBe(1)
  })
})

describe('stepCopy', () => {
  it('maps known actions to i18n keys and humanizes unknown ones', () => {
    expect(stepCopy('android_aab_build')).toMatchObject({ labelKey: 'build-live-step-android-build', whyKey: 'build-live-step-android-build-why' })
    expect(stepCopy('build_cache_fingerprint')).toEqual({ labelKey: null, whyKey: null, fallback: 'Build cache fingerprint' })
  })
})
