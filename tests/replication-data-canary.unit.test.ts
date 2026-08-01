import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDataCanaryCacheForTests,
  evaluateAppVersionsCanary,
  evaluateSubscriptionHealth,
} from '../supabase/functions/_backend/public/replication.ts'

describe('replication data canary evaluation', () => {
  afterEach(() => {
    clearDataCanaryCacheForTests()
  })

  it('accepts similar app_versions counts within 1%', () => {
    expect(evaluateAppVersionsCanary(1000, 995)).toMatchObject({
      status: 'ok',
      diff: 5,
      reasons: [],
    })
  })

  it('rejects empty replica when primary has rows', () => {
    expect(evaluateAppVersionsCanary(120, 0)).toMatchObject({
      status: 'ko',
      reasons: ['replica_empty'],
    })
  })

  it('rejects count drift above threshold', () => {
    expect(evaluateAppVersionsCanary(1000, 900)).toMatchObject({
      status: 'ko',
      reasons: ['count_mismatch'],
    })
  })

  it('treats one healthy subscription as ok even with a disabled sibling', () => {
    const result = evaluateSubscriptionHealth([
      {
        subname: 'capgo_google_eu_2',
        subenabled: false,
        has_apply_worker: false,
        has_recent_receipt: false,
        apply_lag_seconds: null,
        last_msg_receipt_time: null,
      },
      {
        subname: 'capgo_google_eu_2_sub',
        subenabled: true,
        has_apply_worker: true,
        has_recent_receipt: true,
        apply_lag_seconds: 2,
        last_msg_receipt_time: '2026-08-01T07:00:00.000Z',
      },
    ])

    expect(result.status).toBe('ok')
    expect(result.subscriptions.find(s => s.subname === 'capgo_google_eu_2_sub')?.status).toBe('ok')
  })

  it('fails when any enabled subscription is unhealthy', () => {
    const result = evaluateSubscriptionHealth([
      {
        subname: 'capgo_google_eu_2',
        subenabled: true,
        has_apply_worker: false,
        has_recent_receipt: false,
        apply_lag_seconds: null,
        last_msg_receipt_time: null,
      },
      {
        subname: 'capgo_google_eu_2_sub',
        subenabled: true,
        has_apply_worker: true,
        has_recent_receipt: true,
        apply_lag_seconds: 2,
        last_msg_receipt_time: '2026-08-01T07:00:00.000Z',
      },
    ])

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('no_apply_worker')
  })

  it('marks enabled subscription without apply worker as ko', () => {
    const result = evaluateSubscriptionHealth([
      {
        subname: 'capgo_google_eu_2_sub',
        subenabled: true,
        has_apply_worker: false,
        has_recent_receipt: false,
        apply_lag_seconds: null,
        last_msg_receipt_time: null,
      },
    ])

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('no_apply_worker')
  })

  it('marks enabled subscription with pid but no receipt as ko', () => {
    const result = evaluateSubscriptionHealth([
      {
        subname: 'capgo_google_eu_2_sub',
        subenabled: true,
        has_apply_worker: true,
        has_recent_receipt: false,
        apply_lag_seconds: null,
        last_msg_receipt_time: null,
      },
    ])

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('no_recent_receipt')
  })

  it('marks apply lag above threshold as ko', () => {
    const result = evaluateSubscriptionHealth([
      {
        subname: 'capgo_google_eu_2_sub',
        subenabled: true,
        has_apply_worker: true,
        has_recent_receipt: true,
        apply_lag_seconds: 400,
        last_msg_receipt_time: '2026-08-01T06:50:00.000Z',
      },
    ], 180)

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('apply_lag_threshold_exceeded')
  })
})
