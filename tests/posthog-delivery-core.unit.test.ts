import { afterEach, expect, it, vi } from 'vitest'
import { deliverPosthogCapture } from '../supabase/functions/_backend/utils/posthog_delivery.ts'

afterEach(() => vi.unstubAllGlobals())
it('delivers provider-ready snapshots without any Hono context or database', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('1'))
  vi.stubGlobal('fetch', fetch)
  const payload = { event: 'Example', channel: 'test', event_id: '031c6527-7d90-842d-9abd-17f442067e20', distinct_id: 'example-actor', timestamp: '2026-10-06T10:00:00.000Z' }
  expect(await deliverPosthogCapture({ apiKey: 'current-key', host: 'https://example.com/capture/' }, payload)).toMatchObject({ outcome: 'delivered', legacy_success: true })
  expect(fetch.mock.calls[0][0]).toBe('https://example.com/capture/')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ uuid: payload.event_id, timestamp: payload.timestamp, distinct_id: payload.distinct_id, api_key: 'current-key' })
})

it.each(['file:///tmp/posthog', 'https://user:password@example.com', '://invalid'])('rejects unsafe or invalid host %s without fetching', async (host) => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await deliverPosthogCapture({ apiKey: 'key', host }, { event: 'Example', channel: 'test' })).toMatchObject({ outcome: 'permanent_failure', reason: 'invalid_payload_or_host' })
  expect(fetch).not.toHaveBeenCalled()
})
