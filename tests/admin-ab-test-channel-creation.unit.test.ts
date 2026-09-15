import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_CHANNEL_ANIMATION_STAGES,
  buildAdminABTestChannelCreation,
  buildAdminChannelAnimationHogql,
  getAdminABTestChannelCreation,
} from '../supabase/functions/_backend/utils/ab_test_channel_creation.ts'

const { closeClientMock, getPgClientMock, posthogQueryMock, queryMock } = vi.hoisted(() => ({
  closeClientMock: vi.fn(async () => undefined),
  getPgClientMock: vi.fn(),
  posthogQueryMock: vi.fn(),
  queryMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({
  queryPosthogHogql: posthogQueryMock,
}))

const animationRow = {
  stage: 'channel-self-assign',
  reached: '9',
  started: 9,
  completed: '6',
  skipped: 2,
  interrupted: 1,
  continued: 7,
  replays: 2,
  median_watch_ms: 42_000,
  median_skip_progress_percentage: 46,
  retention_25: 8,
  retention_50: 7,
  retention_75: 6,
  skipped_0_24: 0,
  skipped_25_49: 1,
  skipped_50_74: 1,
  skipped_75_99: 0,
  automatic_users: 9,
  automatic_completed: 6,
  automatic_continued: 7,
  automatic_median_watch_ms: 42_000,
  replay_users: 2,
  replay_completed: 2,
  replay_continued: 2,
  replay_median_watch_ms: 48_000,
  reduced_motion_users: 1,
  reduced_motion_continued: 1,
  unavailable_users: 0,
  unavailable_continued: 0,
}

describe('admin channel creation A/B analytics', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getPgClientMock.mockReturnValue({ query: queryMock })
    queryMock.mockResolvedValue({ rows: [] })
    posthogQueryMock.mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [] })
  })

  it('keeps the causal experiment separate from per-animation diagnostics', () => {
    const analytics = buildAdminABTestChannelCreation([
      { branch: 'A', assigned: 11, eligible: 8, converted: 4, pending: 3 },
      { branch: 'B', assigned: 16, eligible: 12, converted: 5, pending: 4 },
    ], {
      configured: true,
      connected: true,
      failureReason: null,
      rows: [animationRow],
    }, '2026-09-14T12:00:00.000Z')

    expect(analytics.experiment).toMatchObject({
      difference_percentage_points: 8.3,
      observation_window_hours: 24,
      status: 'collecting',
      total_assigned: 27,
    })
    expect(analytics.experiment.branches).toEqual([
      expect.objectContaining({ branch: 'A', assigned: 11, eligible: 8, converted: 4, pending: 3 }),
      expect.objectContaining({ branch: 'B', assigned: 16, eligible: 12, converted: 5, pending: 4 }),
    ])
    expect(analytics.stages.map(stage => stage.stage)).toEqual(ADMIN_CHANNEL_ANIMATION_STAGES)
    expect(analytics.stages[1]).toMatchObject({
      reached: 9,
      started: 9,
      completed: 6,
      completion_percentage: 66.7,
      continued: 7,
      continued_percentage: 77.8,
      median_skip_progress_percentage: 46,
      median_watch_ms: 42_000,
      replays: 2,
    })
    expect(analytics.stages[1].retention.map(point => point.viewers)).toEqual([9, 8, 7, 6, 6])
    expect(analytics.stages[1].cohorts).toEqual([
      expect.objectContaining({ cohort: 'automatic', users: 9, completed: 6, continued: 7 }),
      expect.objectContaining({ cohort: 'replay', users: 2, completed: 2, continued: 2 }),
      expect.objectContaining({ cohort: 'reduced_motion', users: 1, completed: null, continued: 1 }),
      expect.objectContaining({ cohort: 'unavailable', users: 0, completed: null, continued: 0 }),
    ])
  })

  it('only reports a leader after both branches have enough eligible observations', () => {
    const analytics = buildAdminABTestChannelCreation([
      { branch: 'A', assigned: 120, eligible: 100, converted: 60, pending: 20 },
      { branch: 'B', assigned: 120, eligible: 100, converted: 40, pending: 20 },
    ], {
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    })

    expect(analytics.experiment.status).toBe('treatment_ahead')
    expect(analytics.experiment.confidence_percentage).toBeGreaterThan(95)
    expect(analytics.experiment.confidence_interval_percentage_points?.low).toBeGreaterThan(0)
    expect(analytics.data_quality).toEqual({
      posthog_configured: false,
      posthog_connected: false,
      posthog_failure_reason: 'unconfigured',
    })
  })

  it('handles complete branch separation without producing a zero-confidence result', () => {
    const analytics = buildAdminABTestChannelCreation([
      { branch: 'A', assigned: 100, eligible: 100, converted: 100, pending: 0 },
      { branch: 'B', assigned: 100, eligible: 100, converted: 0, pending: 0 },
    ], {
      configured: true,
      connected: true,
      failureReason: null,
      rows: [],
    })

    expect(analytics.experiment.status).toBe('treatment_ahead')
    expect(analytics.experiment.confidence_percentage).toBe(100)
    expect(analytics.experiment.confidence_interval_percentage_points).toEqual({ high: 100, low: 100 })
  })

  it('builds a production-only, first-run animation query', () => {
    const query = buildAdminChannelAnimationHogql()

    expect(query).toContain(`toString(properties.onboarding_version) = '5.E'`)
    expect(query).toContain(`JSONExtractString(toString(properties), 'channel_stage')`)
    expect(query).toContain(`JSONExtractString(toString(properties), '$host') = 'console.capgo.app'`)
    expect(query).toContain(`run_index = 1`)
    expect(query).toContain(`run_index > 1`)
    expect(query).toContain(`quantileIf(0.5)`)
    for (const stage of ADMIN_CHANNEL_ANIMATION_STAGES)
      expect(query).toContain(`'${stage}'`)
  })

  it('queries matured channel outcomes and PostHog, then closes the replica pool', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { branch: 'A', assigned: '11', eligible: '8', converted: '4', pending: '3' },
        { branch: 'B', assigned: '16', eligible: '12', converted: '5', pending: '4' },
      ],
    })
    posthogQueryMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [animationRow],
    })
    const context = { get: vi.fn(() => 'request-id') } as never

    const analytics = await getAdminABTestChannelCreation(context)

    expect(getPgClientMock).toHaveBeenCalledWith(context, true)
    expect(queryMock).toHaveBeenCalledOnce()
    const [query, parameters] = queryMock.mock.calls[0] ?? []
    expect(query).toContain('FROM public.audit_logs AS audit_log')
    expect(query).toContain(`(user_account.onboarding -> 'abtests') ? $1`)
    expect(query).toContain(`audit_log.table_name = 'channels'`)
    expect(query).toContain('audit_log.user_id = assigned_user.id')
    expect(query).toContain('make_interval(hours => $3)')
    expect(parameters).toEqual(['new_channel', ['A', 'B'], 24])
    expect(posthogQueryMock).toHaveBeenCalledOnce()
    expect(analytics.experiment.total_assigned).toBe(27)
    expect(closeClientMock).toHaveBeenCalledWith(context, expect.anything())
  })
})
