import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureProperties, deliverPosthogCapture } from '../supabase/functions/_backend/utils/posthog_delivery.ts'
import { processPostHogQueueBatch } from '../supabase/functions/_backend/utils/posthog_queue.ts'
import { sendEventToTracking } from '../supabase/functions/_backend/utils/tracking.ts'

// Documentation addresses only (RFC 5737).
const CLIENT_IP = '203.0.113.7'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function stubPosthog() {
  const fetch = vi.fn().mockResolvedValue(new Response('{"status":"Ok"}'))
  vi.stubGlobal('fetch', fetch)
  return () => JSON.parse(fetch.mock.calls[0][1].body)
}

describe('client IP on worker-sent PostHog events', () => {
  it('puts the client IP in $ip, the property PostHog geolocates, over any caller tag', () => {
    expect(captureProperties({ event: 'User CLI login', channel: 'user-login', ip: CLIENT_IP, tags: { $ip: '198.51.100.1' } }).$ip).toBe(CLIENT_IP)
    expect(captureProperties({ event: 'User CLI login', channel: 'user-login' })).not.toHaveProperty('$ip')
  })

  it('sends $ip on direct captures', async () => {
    const body = stubPosthog()
    await deliverPosthogCapture({ apiKey: 'key' }, { event: 'Hosted MCP Tool Invoked', channel: 'mcp-hosted', distinct_id: 'actor', ip: CLIENT_IP })
    expect(body().properties.$ip).toBe(CLIENT_IP)
  })

  it('sends $ip for CLI events delivered from the queue', async () => {
    const body = stubPosthog()
    const ack = vi.fn()
    await processPostHogQueueBatch({
      messages: [{
        attempts: 1,
        ack,
        retry: vi.fn(),
        body: {
          version: 1,
          source: 'private_events',
          event_id: '031c6527-7d90-842d-9abd-17f442067e20',
          accepted_at: '2026-11-27T10:00:00.000Z',
          request_id: 'request',
          payload: { event: 'User CLI login', channel: 'user-login', distinct_id: 'actor', ip: CLIENT_IP, timestamp: '2026-11-27T10:00:00.000Z' },
        },
      }],
    } as never, { POSTHOG_API_KEY: 'key', POSTHOG_API_HOST: 'https://example.com/capture/' } as never)
    expect(ack).toHaveBeenCalled()
    expect(body().properties.$ip).toBe(CLIENT_IP)
  })

  it('takes the client IP from cf-connecting-ip when the worker tracks an event', async () => {
    const body = stubPosthog()
    // The worker env adapter reads process env under Node.
    vi.stubEnv('POSTHOG_API_KEY', 'key')
    vi.stubEnv('POSTHOG_API_HOST', 'https://example.com/capture/')
    const app = new Hono()
    app.get('/', async (c) => {
      await sendEventToTracking(c, { event: 'API Call', channel: 'cli-perf', user_id: 'actor' }, { background: false, strict: true })
      return c.text('ok')
    })
    const res = await app.request('/', { headers: { 'cf-connecting-ip': CLIENT_IP } })
    expect(await res.text()).toBe('ok')
    expect(body().properties.$ip).toBe(CLIENT_IP)
  })
})
