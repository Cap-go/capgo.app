import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendEvent } from '~/services/tracking'

const { fetchMock, getSessionMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getSessionMock: vi.fn(),
}))

vi.mock('~/services/supabase', () => ({
  defaultApiHost: 'https://api.capgo.test',
  useSupabase: () => ({
    auth: {
      getSession: getSessionMock,
    },
  }),
}))

describe('frontend analytics tracking', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    getSessionMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the analytics request alive when the document unloads', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'test-access-token',
        },
      },
    })
    fetchMock.mockResolvedValue({ ok: true })

    await sendEvent({
      channel: 'usage',
      event: 'Navigation Started',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.capgo.test/private/events',
      expect.objectContaining({
        body: expect.any(String),
        headers: {
          'Authorization': 'Bearer test-access-token',
          'Content-Type': 'application/json',
        },
        keepalive: true,
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      channel: 'usage',
      event: 'Navigation Started',
      client_event_id: expect.any(String),
      timestamp: expect.any(Number),
    })
  })

  it('uses an ordinary fetch when the event exceeds the keepalive body limit', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock.mockResolvedValue({ ok: true })

    await sendEvent({
      channel: 'usage',
      event: 'Oversized Event',
      description: 'x'.repeat(64 * 1024),
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.capgo.test/private/events',
      expect.objectContaining({ keepalive: false }),
    )
  })

  it('uses an ordinary fetch when concurrent events exhaust the keepalive body budget', async () => {
    let finishFirstRequest: (() => void) | undefined
    const firstRequest = new Promise<{ ok: boolean }>((resolve) => {
      finishFirstRequest = () => resolve({ ok: true })
    })
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce({ ok: true })

    const firstEvent = sendEvent({
      channel: 'usage',
      event: 'First Concurrent Event',
      description: 'x'.repeat(40 * 1024),
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    const secondEvent = sendEvent({
      channel: 'usage',
      event: 'Second Concurrent Event',
      description: 'x'.repeat(40 * 1024),
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ keepalive: true }))
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ keepalive: false }))

    finishFirstRequest?.()
    await Promise.all([firstEvent, secondEvent])
  })

  it('does not send an event without an authenticated session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })

    await expect(sendEvent({ channel: 'usage', event: 'Ignored Event' })).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries server errors and consumes their responses', async () => {
    const readFirstError = vi.fn(async () => '')
    const readSecondError = vi.fn(async () => '')
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: readFirstError })
      .mockResolvedValueOnce({ ok: false, status: 502, text: readSecondError })
      .mockResolvedValueOnce({ ok: true })

    await sendEvent({ channel: 'usage', event: 'Retry Event' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(readFirstError).toHaveBeenCalledOnce()
    expect(readSecondError).toHaveBeenCalledOnce()
  })

  it('freezes one ID, timestamp, and serialized body across server and network retries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'))
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
    const stringify = vi.spyOn(JSON, 'stringify')
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'test-access-token' } } })
    const payload = { channel: 'usage', event: 'Stable Retry', tags: { step: 1 } }
    fetchMock.mockImplementationOnce(async () => {
      payload.tags.step = 2
      vi.setSystemTime(new Date('2026-10-06T10:01:00Z'))
      return { ok: false, status: 503, text: async () => '' }
    }).mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValueOnce({ ok: true })

    await sendEvent(payload)

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(stringify).toHaveBeenCalledOnce()
    const bodies = fetchMock.mock.calls.map(call => call[1].body)
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0])).toEqual({
      channel: 'usage',
      event: 'Stable Retry',
      tags: { step: 1 },
      client_event_id: randomUUID.mock.results[0].value,
      timestamp: Date.parse('2026-10-06T10:00:00Z'),
    })
  })

  it('freezes a supplied Date and event ID without regenerating them', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'test-access-token' } } })
    fetchMock.mockResolvedValue({ ok: true })
    const timestamp = new Date('2026-10-06T09:00:00Z')
    const clientEventId = '031c6527-7d90-442d-9abd-17f442067e20'
    const randomUUID = vi.spyOn(crypto, 'randomUUID')

    await sendEvent({ channel: 'usage', event: 'Supplied Identity', timestamp, client_event_id: clientEventId })

    expect(randomUUID).not.toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ timestamp: timestamp.getTime(), client_event_id: clientEventId })
  })

  it('does not retry a client error', async () => {
    const readError = vi.fn(async () => '')
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: readError })

    await sendEvent({ channel: 'usage', event: 'Rejected Event' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(readError).toHaveBeenCalledOnce()
  })

  it('ignores failures while consuming an error response', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn(async () => {
        throw new Error('response body unavailable')
      }),
    })

    await expect(sendEvent({ channel: 'usage', event: 'Unreadable Error' })).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('retries network errors without surfacing analytics failures', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock.mockRejectedValue(new Error('fetch failed'))

    await expect(sendEvent({ channel: 'usage', event: 'Network Failure' })).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not surface session lookup failures', async () => {
    getSessionMock.mockRejectedValue(new Error('session unavailable'))

    await expect(sendEvent({ channel: 'usage', event: 'Session Failure' })).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts and retries requests that exceed the timeout', async () => {
    vi.useFakeTimers()
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    })
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }))
      })
    }))

    try {
      const result = sendEvent({ channel: 'usage', event: 'Timed Out Event' })
      await vi.advanceTimersByTimeAsync(10000)
      await vi.advanceTimersByTimeAsync(10000)
      await vi.advanceTimersByTimeAsync(10000)

      await expect(result).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
