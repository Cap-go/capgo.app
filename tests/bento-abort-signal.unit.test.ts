import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { syncBentoSubscriberTags, trackBentoEvents, unsubscribeBento } from '../supabase/functions/_backend/utils/bento.ts'

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

function createContext() {
  return {
    get: vi.fn(() => 'request-id'),
  } as unknown as Context
}

const subscriberUpdate = {
  deleteSegments: ['onboarding:awaiting_first_org'],
  email: 'deleted.user@example.com',
  segments: ['onboarding:first_org_recovery_suppressed'],
}

describe('bento abort signals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards each optional signal to the exact Bento fetch', async () => {
    const fetchMock = vi.fn<(
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>>(async () => new Response(JSON.stringify({
      failed: 0,
      results: 1,
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const subscriberController = new AbortController()
    const unsubscribeController = new AbortController()
    await expect(syncBentoSubscriberTags(
      createContext(),
      subscriberUpdate,
      subscriberController.signal,
    )).resolves.toBe(true)
    await expect(unsubscribeBento(
      createContext(),
      subscriberUpdate.email,
      unsubscribeController.signal,
    )).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [subscriberUrl, subscriberInit] = fetchMock.mock.calls[0]!
    const [unsubscribeUrl, unsubscribeInit] = fetchMock.mock.calls[1]!
    expect(String(subscriberUrl)).toContain('/api/v1/batch/subscribers')
    expect(subscriberInit?.signal).toBe(subscriberController.signal)
    expect(String(unsubscribeUrl)).toContain('/api/v1/fetch/commands')
    expect(unsubscribeInit?.signal).toBe(unsubscribeController.signal)
  })

  it('forwards the optional trackBentoEvents signal to the exact Bento fetch', async () => {
    const fetchMock = vi.fn<(
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>>(async () => new Response(JSON.stringify({
      failed: 0,
      results: 2,
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    await expect(trackBentoEvents(createContext(), 'event.user@example.com', [
      { event: 'cli:command_invoked', data: { occurrence_count: 1 } },
      { event: 'cli:login_successful', data: { occurrence_count: 2 } },
    ], controller.signal)).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://app.bentonow.com/api/v1/batch/events?site_uuid=site-uuid-value')
    expect(init?.signal).toBe(controller.signal)
  })

  it.each([
    [
      'subscriber synchronization',
      (context: Context, signal: AbortSignal) => syncBentoSubscriberTags(context, subscriberUpdate, signal),
    ],
    [
      'unsubscribe',
      (context: Context, signal: AbortSignal) => unsubscribeBento(context, subscriberUpdate.email, signal),
    ],
  ])('settles %s as failed when its fetch is aborted', async (_label, operation) => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
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
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const result = operation(createContext(), controller.signal)
    expect(fetchMock).toHaveBeenCalledOnce()
    controller.abort()

    await expect(result).resolves.toBe(false)
  })
})
