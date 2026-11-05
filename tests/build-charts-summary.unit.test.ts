import { describe, expect, it } from 'vitest'
import { formatBuildDuration, summarizeBuilds } from '../src/services/buildCharts'

function row(overrides: Partial<Parameters<typeof summarizeBuilds>[0][number]> = {}) {
  return {
    app_id: 'com.example.one',
    status: 'succeeded',
    created_at: '2026-10-01T10:00:00.000Z',
    started_at: '2026-10-01T10:01:00.000Z',
    completed_at: '2026-10-01T10:06:00.000Z',
    runner_wait_seconds: 60,
    ...overrides,
  }
}

describe('summarizeBuilds', () => {
  it('returns empty totals without rows', () => {
    const { totals, apps } = summarizeBuilds([])
    expect(apps).toEqual([])
    expect(totals).toEqual({ total: 0, succeeded: 0, failed: 0, inProgress: 0, successRate: null, avgDurationSeconds: null, avgWaitSeconds: null })
  })

  it('aggregates org totals and a per-app breakdown sorted by volume', () => {
    const { totals, apps } = summarizeBuilds([
      row(),
      row({ status: 'failed', completed_at: '2026-10-01T10:04:00.000Z', runner_wait_seconds: 0 }),
      row({ status: 'running', completed_at: null, created_at: '2026-10-02T10:00:00.000Z' }),
      row({ app_id: 'com.example.two', status: 'completed', runner_wait_seconds: 120 }),
      row({ status: 'pending', started_at: null, completed_at: null, runner_wait_seconds: 0 }),
    ])

    expect(totals.total).toBe(5)
    expect(totals.succeeded).toBe(2)
    expect(totals.failed).toBe(1)
    expect(totals.inProgress).toBe(2)
    expect(totals.successRate).toBeCloseTo((2 / 3) * 100)
    // Finished runs: 300s, 180s, 300s
    expect(totals.avgDurationSeconds).toBe(260)
    // Started runs only: 60, 0, 60, 120 (pending row has not started)
    expect(totals.avgWaitSeconds).toBe(60)

    expect(apps.map(app => app.appId)).toEqual(['com.example.one', 'com.example.two'])
    expect(apps[0]).toMatchObject({ total: 4, succeeded: 1, failed: 1, inProgress: 2, successRate: 50, lastBuildAt: '2026-10-02T10:00:00.000Z' })
    expect(apps[1]).toMatchObject({ total: 1, succeeded: 1, failed: 0, successRate: 100, avgDurationSeconds: 300 })
  })
})

describe('formatBuildDuration', () => {
  it('formats compact durations', () => {
    expect(formatBuildDuration(null)).toBe('-')
    expect(formatBuildDuration(45.4)).toBe('45s')
    expect(formatBuildDuration(200)).toBe('3m 20s')
    expect(formatBuildDuration(3900)).toBe('1h 05m')
  })
})
