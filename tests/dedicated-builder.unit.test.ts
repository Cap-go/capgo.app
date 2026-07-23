import { describe, expect, it } from 'vitest'
import {
  deriveWorkerStatus,
  isDedicatedBuilderActive,
  publicDedicatedBuilderView,
  toDedicatedPoolRouting,
} from '../supabase/functions/_backend/utils/dedicated_builder.ts'

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-1',
    org_id: 'org-1',
    status: 'active',
    requested_by: 'user-1',
    use_case: 'CI',
    monthly_builds_estimate: 40,
    platforms: ['ios', 'android'],
    allow_shared_fallback: true,
    pool_id: 'pool-org-1',
    worker_name: 'org-1-worker',
    worker_status: 'idle',
    worker_current_job_id: null,
    worker_last_seen_at: null,
    activated_at: '2026-07-01T00:00:00.000Z',
    suspended_at: null,
    cancelled_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as any
}

describe('dedicated builder helpers', () => {
  it.concurrent('treats only active status as routable', () => {
    expect(isDedicatedBuilderActive(makeRow({ status: 'active' }))).toBe(true)
    expect(isDedicatedBuilderActive(makeRow({ status: 'requested' }))).toBe(false)
    expect(isDedicatedBuilderActive(makeRow({ status: 'provisioning' }))).toBe(false)
    expect(isDedicatedBuilderActive(null)).toBe(false)
  })

  it.concurrent('builds pool routing only for active dedicated builders', () => {
    expect(toDedicatedPoolRouting(makeRow({ allow_shared_fallback: false }))).toEqual({
      preferDedicated: true,
      allowSharedFallback: false,
      poolId: 'pool-org-1',
      workerName: 'org-1-worker',
    })
    expect(toDedicatedPoolRouting(makeRow({ status: 'requested' }))).toBeNull()
  })

  it.concurrent('derives busy from active dedicated builds only when fallback is off', () => {
    expect(deriveWorkerStatus(makeRow({
      allow_shared_fallback: false,
      worker_status: 'idle',
    }), 0)).toBe('idle')
    expect(deriveWorkerStatus(makeRow({
      allow_shared_fallback: false,
      worker_status: 'idle',
    }), 2)).toBe('busy')
    expect(deriveWorkerStatus(makeRow({ worker_status: 'offline' }), 0)).toBe('offline')
    expect(deriveWorkerStatus(makeRow({ status: 'requested' }), 1)).toBe('unknown')
  })

  it.concurrent('does not infer busy from preferred-pool counts when shared fallback is on', () => {
    expect(deriveWorkerStatus(makeRow({
      allow_shared_fallback: true,
      worker_status: 'idle',
    }), 2)).toBe('idle')
    expect(deriveWorkerStatus(makeRow({
      allow_shared_fallback: true,
      worker_status: 'busy',
    }), 0)).toBe('busy')
    expect(deriveWorkerStatus(makeRow({
      allow_shared_fallback: true,
      worker_status: 'unknown',
    }), 2)).toBe('unknown')
  })

  it.concurrent('exposes a sanitized public view with derived worker status', () => {
    const view = publicDedicatedBuilderView(makeRow({
      allow_shared_fallback: false,
      worker_status: 'idle',
      worker_current_job_id: 'job-9',
    }), 1)
    expect(view.worker_status).toBe('busy')
    expect(view.active_dedicated_builds).toBe(1)
    expect(view.pool_id).toBe('pool-org-1')
    expect(view.allow_shared_fallback).toBe(false)
  })
})
