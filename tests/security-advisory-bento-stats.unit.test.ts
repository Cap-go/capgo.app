import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BentoApiError } from '../supabase/functions/_backend/utils/bento.ts'
import {
  loadSecurityAdvisoryBentoEmailStats,
  loadSecurityAdvisoryBentoEmailStatsBatch,
  SECURITY_ADVISORY_EMAIL_SENT_EVENT,
} from '../supabase/functions/_backend/utils/security_advisory_bento_stats.ts'

const bentoGet = vi.hoisted(() => vi.fn())
const isBentoConfigured = vi.hoisted(() => vi.fn(() => true))

vi.mock('../supabase/functions/_backend/utils/bento.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/bento.ts')>()
  return {
    ...actual,
    bentoGet,
    isBentoConfigured,
  }
})

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

const emptyExportPage = { data: [], meta: { next_cursor: null, truncated: false } }

describe('loadSecurityAdvisoryBentoEmailStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isBentoConfigured.mockReturnValue(true)
  })

  it('returns zeros when Bento is not configured', async () => {
    isBentoConfigured.mockReturnValue(false)
    const stats = await loadSecurityAdvisoryBentoEmailStats(context(), 'GHSA-example-0001')
    expect(stats.bento_configured).toBe(false)
    expect(stats.sent).toBe(0)
  })

  it('counts sent events that match the advisory ghsa_id in details', async () => {
    bentoGet.mockImplementation((_c, _path, _site, query) => {
      if (query?.type === SECURITY_ADVISORY_EMAIL_SENT_EVENT) {
        return Promise.resolve({
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
      }
      return Promise.resolve(emptyExportPage)
    })

    const stats = await loadSecurityAdvisoryBentoEmailStats(context(), 'GHSA-example-0001')
    expect(stats.sent).toBe(1)
    expect(stats.bento_configured).toBe(true)
    expect(bentoGet.mock.calls[0]?.[2]).toBe('site-uuid')
    expect(bentoGet.mock.calls[0]?.[3]?.type).toBe(SECURITY_ADVISORY_EMAIL_SENT_EVENT)
  })

  it('keeps partial counts when a later export page fails', async () => {
    let sentCalls = 0
    bentoGet.mockImplementation((_c, _path, _site, query) => {
      if (query?.type === SECURITY_ADVISORY_EMAIL_SENT_EVENT) {
        sentCalls++
        if (sentCalls === 1) {
          return Promise.resolve({
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
        }
        return Promise.resolve(null)
      }
      return Promise.resolve(emptyExportPage)
    })

    const stats = await loadSecurityAdvisoryBentoEmailStats(context(), 'GHSA-example-0001')
    expect(stats.sent).toBe(1)
    expect(stats.partial).toBe(true)
  })
})

describe('loadSecurityAdvisoryBentoEmailStatsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isBentoConfigured.mockReturnValue(true)
  })

  it('scans each event type once for multiple advisories', async () => {
    bentoGet.mockImplementation((_c, _path, _site, query) => {
      if (query?.type === SECURITY_ADVISORY_EMAIL_SENT_EVENT) {
        return Promise.resolve({
          data: [
            {
              attributes: {
                email: 'a@example.com',
                data: { details: { ghsa_id: 'GHSA-example-0001' } },
              },
            },
            {
              attributes: {
                email: 'b@example.com',
                data: { details: { ghsa_id: 'GHSA-other-0002' } },
              },
            },
          ],
          meta: { next_cursor: null, truncated: false },
        })
      }
      return Promise.resolve(emptyExportPage)
    })

    const batch = await loadSecurityAdvisoryBentoEmailStatsBatch(context(), [
      'GHSA-example-0001',
      'GHSA-other-0002',
    ])
    expect(batch.get('GHSA-EXAMPLE-0001')?.sent).toBe(1)
    expect(batch.get('GHSA-OTHER-0002')?.sent).toBe(1)
    const sentCalls = bentoGet.mock.calls.filter(call => call[3]?.type === SECURITY_ADVISORY_EMAIL_SENT_EVENT)
    expect(sentCalls).toHaveLength(1)
  })

  it('retries once on 429 and marks partial when export stays unavailable', async () => {
    vi.clearAllMocks()
    isBentoConfigured.mockReturnValue(true)
    vi.useFakeTimers()
    let attempts = 0
    bentoGet.mockImplementation((_c, _path, _site, query) => {
      if (query?.type !== SECURITY_ADVISORY_EMAIL_SENT_EVENT)
        return Promise.resolve(emptyExportPage)
      attempts++
      if (attempts === 1)
        return Promise.reject(new BentoApiError(429, 0))
      return Promise.resolve(null)
    })

    const pending = loadSecurityAdvisoryBentoEmailStatsBatch(context(), ['GHSA-example-0001'])
    await vi.advanceTimersByTimeAsync(1_500)
    const batch = await pending
    expect(attempts).toBe(2)
    expect(batch.get('GHSA-EXAMPLE-0001')?.partial).toBe(true)
    vi.useRealTimers()
  })
})
