import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncBentoSubscriberTags, trackBentoEvent, trackBentoEvents, unsubscribeBento } from '../supabase/functions/_backend/utils/bento.ts'

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
})
