import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBentoSubscriberEmailByUuid, parseBentoSubscriberEmail, syncBentoSubscriberTags, trackBentoEvent, trackBentoEvents, unsubscribeBento, updateBentoFields } from '../supabase/functions/_backend/utils/bento.ts'

const { cloudlogErrMock, getEnvMock } = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  getEnvMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: cloudlogErrMock,
  serializeError: (error: unknown) => error,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: getEnvMock,
}))

function configureBentoEnv() {
  getEnvMock.mockImplementation((_context: unknown, key: string) => {
    const values: Record<string, string> = {
      BENTO_PUBLISHABLE_KEY: 'publishable-key-value',
      BENTO_SECRET_KEY: 'secret-key-value',
      BENTO_SITE_UUID: 'site-uuid-value',
    }
    return values[key] ?? ''
  })
}

const fetchMock = vi.fn<(
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>>()

function createContext() {
  return {
    get: vi.fn(() => 'request-id'),
  } as unknown as Context
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}

function queueAcknowledgement(body: unknown) {
  fetchMock.mockResolvedValueOnce(jsonResponse(body))
}

const subscriberUpdates = [
  {
    deleteSegments: [],
    email: 'first.user@example.com',
    segments: ['onboarding:awaiting_first_org'],
  },
  {
    deleteSegments: ['onboarding:awaiting_first_org'],
    email: 'second.user@example.com',
    segments: ['onboarding:first_org_recovery_suppressed'],
  },
]

const events = [
  { event: 'cli:command_invoked', data: { occurrence_count: 1 } },
  { event: 'cli:login_successful', data: { occurrence_count: 2 } },
]

describe('bento response acceptance and configuration', () => {
  beforeEach(() => {
    cloudlogErrMock.mockReset()
    fetchMock.mockReset()
    getEnvMock.mockReset()
    configureBentoEnv()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('syncBentoSubscriberTags', () => {
    it('accepts an acknowledgement for the exact subscriber count', async () => {
      queueAcknowledgement({ failed: 0, results: 2 })

      await expect(syncBentoSubscriberTags(createContext(), subscriberUpdates)).resolves.toBe(true)
    })

    it.each([
      ['zero results', { failed: 0, results: 0 }],
      ['a missing result count', { failed: 0 }],
      ['a missing failure count', { results: 2 }],
      ['a short result count', { failed: 0, results: 1 }],
      ['a malformed result count', { failed: 0, results: '2' }],
      ['a malformed acknowledgement', null],
      ['a non-zero failure count', { failed: 1, results: 2 }],
    ])('rejects %s', async (_label, acknowledgement) => {
      queueAcknowledgement(acknowledgement)

      await expect(syncBentoSubscriberTags(createContext(), subscriberUpdates)).resolves.toBe(false)
    })

    it('logs only numeric acknowledgement counts for a rejected subscriber batch', async () => {
      queueAcknowledgement({
        failed: 1,
        results: 2,
        email: 'private.user@example.com',
        observations: [{ token: 'private-observation-token' }],
        token: 'private-provider-token',
      })

      await expect(syncBentoSubscriberTags(createContext(), subscriberUpdates)).resolves.toBe(false)

      expect(cloudlogErrMock).toHaveBeenCalledWith({
        requestId: 'request-id',
        message: 'syncBentoSubscriberTags',
        error: { failed: 1, results: 2 },
      })
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private.user@example.com')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-observation-token')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-provider-token')
    })
  })

  describe('trackBentoEvent', () => {
    it('accepts an acknowledgement for exactly one event', async () => {
      queueAcknowledgement({ failed: 0, results: 1 })

      await expect(trackBentoEvent(
        createContext(),
        'event.user@example.com',
        { source: 'unit-test' },
        'user:created',
      )).resolves.toBe(true)
    })

    it.each([
      ['zero results', { failed: 0, results: 0 }],
      ['a missing result count', { failed: 0 }],
      ['a missing failure count', { results: 1 }],
      ['a malformed result count', { failed: 0, results: '1' }],
      ['a malformed acknowledgement', null],
      ['a non-zero failure count', { failed: 1, results: 1 }],
    ])('rejects %s', async (_label, acknowledgement) => {
      queueAcknowledgement(acknowledgement)

      await expect(trackBentoEvent(
        createContext(),
        'event.user@example.com',
        { source: 'unit-test' },
        'user:created',
      )).resolves.toBe(false)
    })
  })

  describe('trackBentoEvents', () => {
    it('accepts an empty configured batch without a request', async () => {
      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        [],
      )).resolves.toBe(true)

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('skips an unconfigured batch without a request', async () => {
      getEnvMock.mockReturnValue('')

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBeUndefined()

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('accepts an acknowledgement for the exact event count', async () => {
      queueAcknowledgement({ failed: 0, results: 2 })

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(true)
    })

    it('sends all events in one batch request', async () => {
      queueAcknowledgement({ failed: 0, results: 2 })

      await trackBentoEvents(createContext(), 'event.user@example.com', events)

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({
        events: [
          { type: 'cli:command_invoked', email: 'event.user@example.com', details: { occurrence_count: 1 } },
          { type: 'cli:login_successful', email: 'event.user@example.com', details: { occurrence_count: 2 } },
        ],
      })
    })

    it('logs and rejects a failed request', async () => {
      const error = new Error('Bento request failed')
      fetchMock.mockRejectedValueOnce(error)

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(false)

      expect(cloudlogErrMock).toHaveBeenCalledWith({
        requestId: 'request-id',
        message: 'trackBentoEvents error',
        error,
      })
    })

    it('logs a non-2xx status without reading provider response data', async () => {
      const response = new Response(JSON.stringify({
        email: 'private.user@example.com',
        observations: [{ token: 'private-observation-token' }],
        token: 'private-provider-token',
      }), { status: 422 })
      const cancel = vi.spyOn(response.body!, 'cancel')
      fetchMock.mockResolvedValueOnce(response)

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(false)

      const loggedError = cloudlogErrMock.mock.calls[0]?.[0]?.error
      expect(cancel).toHaveBeenCalledOnce()
      expect(loggedError).toBeInstanceOf(Error)
      expect((loggedError as Error).message).toBe('Bento API error: 422')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private.user@example.com')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-observation-token')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-provider-token')
    })

    it('keeps the status-only error when rejected response cancellation fails', async () => {
      const response = new Response('private-provider-body', { status: 503 })
      const cancel = vi.spyOn(response.body!, 'cancel')
        .mockRejectedValueOnce(new Error('private-cancel-error'))
      fetchMock.mockResolvedValueOnce(response)

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(false)

      const loggedError = cloudlogErrMock.mock.calls[0]?.[0]?.error
      expect(cancel).toHaveBeenCalledOnce()
      expect(loggedError).toBeInstanceOf(Error)
      expect((loggedError as Error).message).toBe('Bento API error: 503')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-provider-body')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-cancel-error')
    })

    it('sanitizes invalid provider JSON without logging response data', async () => {
      fetchMock.mockResolvedValueOnce(new Response(
        '{"token":"private-provider-token", "observations": [',
        { status: 200 },
      ))

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(false)

      const loggedError = cloudlogErrMock.mock.calls[0]?.[0]?.error
      expect(loggedError).toBeInstanceOf(Error)
      expect((loggedError as Error).message).toBe('Bento API returned invalid JSON: 200')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-provider-token')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('observations')
    })

    it.each([
      ['typed counts', {
        failed: 1,
        results: 2,
        email: 'private.user@example.com',
        observations: [{ token: 'private-observation-token' }],
        token: 'private-provider-token',
      }, { failed: 1, results: 2 }],
      ['malformed counts', {
        failed: '1',
        results: '2',
        email: 'private.user@example.com',
        observations: [{ token: 'private-observation-token' }],
        token: 'private-provider-token',
      }, {}],
    ])('logs only an allowlisted summary for rejected batch %s', async (_label, acknowledgement, summary) => {
      queueAcknowledgement(acknowledgement)

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(false)

      expect(cloudlogErrMock).toHaveBeenCalledWith({
        requestId: 'request-id',
        message: 'trackBentoEvents',
        error: summary,
      })
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private.user@example.com')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-observation-token')
      expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('private-provider-token')
    })

    it.each([
      ['a short result count', { failed: 0, results: 1 }],
      ['a non-zero failure count', { failed: 1, results: 2 }],
      ['a malformed acknowledgement', null],
    ])('rejects %s', async (_label, acknowledgement) => {
      queueAcknowledgement(acknowledgement)

      await expect(trackBentoEvents(
        createContext(),
        'event.user@example.com',
        events,
      )).resolves.toBe(false)
    })
  })

  describe('unsubscribeBento', () => {
    it('accepts an acknowledgement for exactly one command', async () => {
      queueAcknowledgement({ results: 1 })

      await expect(unsubscribeBento(createContext(), 'unsubscribed.user@example.com')).resolves.toBe(true)
    })

    it.each([
      ['zero results', { results: 0 }],
      ['a missing result count', {}],
      ['a malformed result count', { results: '1' }],
      ['a malformed acknowledgement', null],
    ])('rejects %s', async (_label, acknowledgement) => {
      queueAcknowledgement(acknowledgement)

      await expect(unsubscribeBento(createContext(), 'unsubscribed.user@example.com')).resolves.toBe(false)
    })
  })

  describe('getBentoSubscriberEmailByUuid', () => {
    const visitorUuid = '11111111-1111-4111-8111-111111111111'

    it('returns the subscriber email from a GET lookup', async () => {
      queueAcknowledgement({
        data: {
          attributes: { email: 'User@Example.com', uuid: visitorUuid },
          id: '1',
          type: 'visitors',
        },
      })

      await expect(getBentoSubscriberEmailByUuid(createContext(), visitorUuid)).resolves.toBe('user@example.com')

      const [url, init] = fetchMock.mock.calls[0]!
      expect(String(url)).toContain('/api/v1/fetch/subscribers')
      expect(String(url)).toContain(`uuid=${visitorUuid}`)
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
    })

    it('returns null when Bento has no subscriber for the uuid', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))

      await expect(getBentoSubscriberEmailByUuid(createContext(), visitorUuid)).resolves.toBeNull()
    })

    it('returns undefined when Bento is not configured', async () => {
      getEnvMock.mockReturnValue('')

      await expect(getBentoSubscriberEmailByUuid(createContext(), visitorUuid)).resolves.toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('parseBentoSubscriberEmail', () => {
    it('reads JSON:API subscriber attributes', () => {
      expect(parseBentoSubscriberEmail({
        data: { attributes: { email: ' User@Example.com ' } },
      })).toBe('user@example.com')
    })

    it('returns null for missing or invalid payloads', () => {
      expect(parseBentoSubscriberEmail(null)).toBeNull()
      expect(parseBentoSubscriberEmail({ data: null })).toBeNull()
      expect(parseBentoSubscriberEmail({ data: { attributes: { email: 1 } } })).toBeNull()
    })
  })

  describe('abort signals', () => {
    const update = subscriberUpdates[1]!
    const eventsUrl = 'https://app.bentonow.com/api/v1/batch/events?site_uuid=site-uuid-value'

    it.each([
      ['subscriber synchronization', { failed: 0, results: 1 }, (c: Context, s: AbortSignal) => syncBentoSubscriberTags(c, update, s), '/api/v1/batch/subscribers', true],
      ['unsubscribe', { failed: 0, results: 1 }, (c: Context, s: AbortSignal) => unsubscribeBento(c, update.email, s), '/api/v1/fetch/commands', true],
      ['event batch tracking', { failed: 0, results: 2 }, (c: Context, s: AbortSignal) => trackBentoEvents(c, 'event.user@example.com', events, s), eventsUrl, true],
      ['field update', { failed: 0, results: 1 }, (c: Context, s: AbortSignal) => updateBentoFields(c, 'event.user@example.com', { preorg_intent: 'builder' }, s), eventsUrl, true],
      ['subscriber uuid lookup', { data: { attributes: { email: 'looked.up@example.com' } } }, (c: Context, s: AbortSignal) => getBentoSubscriberEmailByUuid(c, '11111111-1111-4111-8111-111111111111', s), '/api/v1/fetch/subscribers', 'looked.up@example.com'],
    ] as const)('forwards the optional %s signal to the exact Bento fetch', async (_label, response, operation, url, expected) => {
      queueAcknowledgement(response)
      const controller = new AbortController()
      await expect(operation(createContext(), controller.signal)).resolves.toBe(expected)
      expect(fetchMock).toHaveBeenCalledOnce()
      const [calledUrl, init] = fetchMock.mock.calls[0]!
      expect(String(calledUrl)).toContain(url)
      expect(init?.signal).toBe(controller.signal)
    })

    it('sends field updates through Bento update_fields', async () => {
      queueAcknowledgement({ failed: 0, results: 1 })
      await expect(updateBentoFields(createContext(), 'event.user@example.com', { preorg_intent: 'builder' })).resolves.toBe(true)
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
        events: [{ email: 'event.user@example.com', fields: { preorg_intent: 'builder' }, type: '$update_fields' }],
      })
    })

    it.each([
      ['event batch tracking', (c: Context, s: AbortSignal) => trackBentoEvents(c, update.email, [events[0]!], s)],
      ['subscriber synchronization', (c: Context, s: AbortSignal) => syncBentoSubscriberTags(c, update, s)],
      ['field update', (c: Context, s: AbortSignal) => updateBentoFields(c, update.email, { preorg_intent: 'builder' }, s)],
      ['unsubscribe', (c: Context, s: AbortSignal) => unsubscribeBento(c, update.email, s)],
    ])('settles %s as failed when its fetch is aborted', async (_label, operation) => {
      fetchMock.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('missing abort signal'))
          return
        }
        const rejectAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'))
        if (signal.aborted)
          rejectAbort()
        else
          signal.addEventListener('abort', rejectAbort, { once: true })
      }))
      const controller = new AbortController()
      const result = operation(createContext(), controller.signal)
      expect(fetchMock).toHaveBeenCalledOnce()
      controller.abort()
      await expect(result).resolves.toBe(false)
    })
  })
})
