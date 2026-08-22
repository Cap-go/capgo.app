import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncBentoSubscriberTags, trackBentoEvent, trackBentoEvents, unsubscribeBento } from '../supabase/functions/_backend/utils/bento.ts'

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => error,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_context: unknown, key: string) => {
    const values: Record<string, string> = {
      BENTO_PUBLISHABLE_KEY: 'publishable-key-value',
      BENTO_SECRET_KEY: 'secret-key-value',
      BENTO_SITE_UUID: 'site-uuid-value',
    }
    return values[key] ?? ''
  },
}))

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

describe('configured Bento response acceptance', () => {
  beforeEach(() => {
    fetchMock.mockReset()
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
