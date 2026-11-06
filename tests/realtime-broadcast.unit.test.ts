import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcastCLIEvent } from '../supabase/functions/_backend/utils/realtime_broadcast.ts'

const { cloudlog, env } = vi.hoisted(() => ({
  cloudlog: vi.fn(),
  env: {} as Record<string, string>,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ getEnv: (_c: Context, key: string) => env[key] ?? '' }))

const payload = { event: 'upload', channel: 'production', org_id: 'org-1', timestamp: '2026-10-23T00:00:00.000Z' }

function consoleEventsBinding(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const stub = { fetch: vi.fn(fetch) }
  const binding = {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
  }
  return { binding, stub }
}

function context(consoleEvents?: unknown) {
  return {
    env: consoleEvents ? { CONSOLE_EVENTS: consoleEvents } : {},
    get: (key: string) => key === 'requestId' ? 'req-1' : undefined,
  } as unknown as Context
}

describe('broadcastCLIEvent console fan-out', () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))

  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(env))
      delete env[key]
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the event to the org console events object', async () => {
    const { binding, stub } = consoleEventsBinding(async () => new Response(null, { status: 204 }))
    await broadcastCLIEvent(context(binding), payload)

    expect(binding.idFromName).toHaveBeenCalledWith('org-1')
    expect(binding.get).toHaveBeenCalledWith('id:org-1')
    expect(stub.fetch).toHaveBeenCalledWith('https://console-events/broadcast', { method: 'POST', body: JSON.stringify(payload) })
    expect(cloudlog).not.toHaveBeenCalled()
  })

  it('logs a rejected broadcast', async () => {
    const { binding } = consoleEventsBinding(async () => new Response(null, { status: 413 }))
    await broadcastCLIEvent(context(binding), payload)

    expect(cloudlog).toHaveBeenCalledWith(expect.objectContaining({ message: 'console events broadcast rejected', org_id: 'org-1', status: 413 }))
  })

  it('catches and logs a failed broadcast', async () => {
    const { binding } = consoleEventsBinding(async () => {
      throw new Error('object unavailable')
    })
    await expect(broadcastCLIEvent(context(binding), payload)).resolves.toBeUndefined()

    expect(cloudlog).toHaveBeenCalledWith(expect.objectContaining({ message: 'console events broadcast failed', org_id: 'org-1', error: 'object unavailable' }))
  })

  it('skips the console fan-out without a binding and still reaches Supabase Realtime', async () => {
    env.SUPABASE_URL = 'https://db.example.com'
    env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    await broadcastCLIEvent(context(), payload)

    expect(fetchMock).toHaveBeenCalledWith('https://db.example.com/realtime/v1/api/broadcast', expect.objectContaining({ method: 'POST' }))
    expect(cloudlog).not.toHaveBeenCalled()
  })
})
