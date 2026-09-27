import { describe, expect, it, vi } from 'vitest'
import { onPremiseAppResponse } from '../supabase/functions/_backend/plugin_runtime/utils/rateLimitInfo.ts'

describe('onPremiseAppResponse retry reset preservation', () => {
  it('does not slide Retry-After when an absolute reset is supplied', () => {
    const resetAt = Date.now() + 2_000_000
    const c = {
      header: vi.fn(),
      json: vi.fn((body: unknown, status: number) => ({ body, status })),
    } as any

    onPremiseAppResponse(c, resetAt)

    const retryAfter = Number.parseInt(String(c.header.mock.calls.find(([name]: [string]) => name === 'Retry-After')?.[1] ?? '0'), 10)
    expect(retryAfter).toBeGreaterThan(1900)
    expect(retryAfter).toBeLessThanOrEqual(2000)
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)))
  })
})
