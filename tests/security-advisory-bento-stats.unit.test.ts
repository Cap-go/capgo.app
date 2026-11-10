import { describe, expect, it, vi } from 'vitest'
import {
  loadSecurityAdvisoryBentoEmailStats,
  SECURITY_ADVISORY_EMAIL_SENT_EVENT,
} from '../supabase/functions/_backend/utils/security_advisory_bento_stats.ts'

const bentoGet = vi.hoisted(() => vi.fn())
const isBentoConfigured = vi.hoisted(() => vi.fn(() => true))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  bentoGet,
  isBentoConfigured,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: () => 'site-uuid',
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => error,
}))

function context() {
  return {
    get: () => undefined,
    env: {},
  } as never
}

describe('loadSecurityAdvisoryBentoEmailStats', () => {
  it('returns zeros when Bento is not configured', async () => {
    isBentoConfigured.mockReturnValueOnce(false)
    const stats = await loadSecurityAdvisoryBentoEmailStats(context(), 'GHSA-example-0001')
    expect(stats.bento_configured).toBe(false)
    expect(stats.sent).toBe(0)
  })

  it('counts sent events that match the advisory ghsa_id in details', async () => {
    bentoGet.mockResolvedValueOnce({
      data: [
        {
          attributes: {
            email: 'user@example.com',
            data: { details: { ghsa_id: 'GHSA-example-0001' } },
          },
        },
        {
          attributes: {
            email: 'other@example.com',
            data: { details: { ghsa_id: 'GHSA-other-0002' } },
          },
        },
      ],
      meta: { next_cursor: null, truncated: false },
    })
    bentoGet.mockResolvedValue({ data: [], meta: { next_cursor: null, truncated: false } })

    const stats = await loadSecurityAdvisoryBentoEmailStats(context(), 'GHSA-example-0001')
    expect(stats.sent).toBe(1)
    expect(stats.bento_configured).toBe(true)
    expect(bentoGet.mock.calls[0]?.[2]).toBe('site-uuid')
    expect(bentoGet.mock.calls[0]?.[3]?.type).toBe(SECURITY_ADVISORY_EMAIL_SENT_EVENT)
  })

  it('keeps partial counts when a later export page fails', async () => {
    bentoGet
      .mockResolvedValueOnce({
        data: [
          {
            attributes: {
              email: 'user@example.com',
              data: { details: { ghsa_id: 'GHSA-example-0001' } },
            },
          },
        ],
        meta: { next_cursor: 'cursor-2', truncated: false },
      })
      .mockResolvedValueOnce(null)

    const stats = await loadSecurityAdvisoryBentoEmailStats(context(), 'GHSA-example-0001')
    expect(stats.sent).toBe(1)
    expect(stats.partial).toBe(true)
  })
})
