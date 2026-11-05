import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDataCanaryCacheForTests,
  evaluateAppVersionsCanary,
  evaluateSubscriptionHealth,
} from '../supabase/functions/_backend/public/replication.ts'

type Subscription = Parameters<typeof evaluateSubscriptionHealth>[0][number]

const healthy: Subscription = {
  subname: 'capgo_google_eu_2_sub',
  subenabled: true,
  has_apply_worker: true,
  has_recent_receipt: true,
  apply_lag_seconds: 2,
  last_msg_receipt_time: '2026-08-01T07:00:00.000Z',
}

const stalled: Subscription = {
  subname: 'capgo_google_eu_2',
  subenabled: true,
  has_apply_worker: false,
  has_recent_receipt: false,
  apply_lag_seconds: null,
  last_msg_receipt_time: null,
}

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

  it.each([
    ['empty replica when primary has rows', 120, 0, 'replica_empty'],
    ['empty replica even when primary is empty', 0, 0, 'replica_empty'],
    ['count drift above threshold', 1000, 900, 'count_mismatch'],
  ])('rejects %s', (_name, primary, replica, reason) => {
    expect(evaluateAppVersionsCanary(primary, replica)).toMatchObject({
      status: 'ko',
      reasons: [reason],
    })
  })

  it('treats one healthy subscription as ok even with a disabled sibling', () => {
    const result = evaluateSubscriptionHealth([{ ...stalled, subenabled: false }, healthy])

    expect(result.status).toBe('ok')
    expect(result.subscriptions.find(s => s.subname === 'capgo_google_eu_2')?.status).toBe('disabled')
    expect(result.subscriptions.find(s => s.subname === 'capgo_google_eu_2_sub')?.status).toBe('ok')
  })

  it('fails when any enabled subscription is unhealthy', () => {
    const result = evaluateSubscriptionHealth([stalled, healthy])

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('no_apply_worker')
  })

  it.each([
    ['without apply worker', { ...stalled, subname: healthy.subname }, undefined, 'no_apply_worker'],
    ['with pid but no receipt', { ...stalled, subname: healthy.subname, has_apply_worker: true }, undefined, 'no_recent_receipt'],
    ['with apply lag above threshold', { ...healthy, apply_lag_seconds: 400, last_msg_receipt_time: '2026-08-01T06:50:00.000Z' }, 180, 'apply_lag_threshold_exceeded'],
  ] as const)('marks an enabled subscription %s as ko', (_name, subscription, threshold, reason) => {
    const result = evaluateSubscriptionHealth([subscription], threshold)

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain(reason)
  })
})
