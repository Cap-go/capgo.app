import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, mockEnd, mockRelease, MockPool } = vi.hoisted(() => {
  const mockRelease = vi.fn()
  const mockConnect = vi.fn()
  const mockEnd = vi.fn().mockResolvedValue(undefined)
  class MockPool {
    connect = mockConnect
    end = mockEnd
    constructor(_opts: unknown) {}
  }
  return { mockConnect, mockEnd, mockRelease, MockPool }
})

vi.mock('pg', () => ({
  Pool: MockPool,
}))

import { pingDatabase } from '../supabase/functions/_backend/utils/capgo_health.ts'

describe('pingDatabase', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('destroys the client when the probe aborts before the query settles', async () => {
    let rejectQuery: (err: Error) => void = () => {}
    const queryPromise = new Promise<unknown>((_, reject) => {
      rejectQuery = reject
    })
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(queryPromise),
      release: mockRelease,
    }
    mockConnect.mockResolvedValue(client)

    const controller = new AbortController()
    const ping = pingDatabase('postgres://example.test/db', controller.signal)

    await Promise.resolve()
    controller.abort()

    await expect(ping).rejects.toThrow('aborted')
    expect(mockRelease).toHaveBeenCalledWith(true)
    expect(mockEnd).toHaveBeenCalled()
    rejectQuery(new Error('cancelled'))
  })

  it('releases the client normally when the query completes', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }),
      release: mockRelease,
    }
    mockConnect.mockResolvedValue(client)

    await pingDatabase('postgres://example.test/db', new AbortController().signal)

    expect(mockRelease).toHaveBeenCalledWith()
    expect(mockRelease).not.toHaveBeenCalledWith(true)
    expect(mockEnd).toHaveBeenCalled()
  })
})
