import { describe, expect, it } from 'vitest'
import { respondOpenStatusAdminCheck } from '../supabase/functions/_backend/utils/capgo_health.ts'

describe('respondOpenStatusAdminCheck', () => {
  it('returns Capgo ok|ko status with legacy fields, not OpenStatus status', async () => {
    const c = {
      req: { method: 'GET' },
      env: {},
    } as Parameters<typeof respondOpenStatusAdminCheck>[0]

    const response = await respondOpenStatusAdminCheck(c, {
      probeName: 'pgmq_queues',
      runAssessment: async () => ({
        capgoStatus: 'ko',
        httpStatus: 503,
        legacyBody: {
          status: 'ko',
          checked_at: '2026-01-01T00:00:00.000Z',
          queue_count: 2,
        },
      }),
    })

    expect(response.status).toBe(503)
    const body = await response.json() as Record<string, unknown>
    expect(body.status).toBe('ko')
    expect(body).not.toHaveProperty('capgo_status')
    expect(body.queue_count).toBe(2)
    expect(body.checked_at).toBe('2026-01-01T00:00:00.000Z')
    expect(body.status).not.toBe('unhealthy')
  })
})
