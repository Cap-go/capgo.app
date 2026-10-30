import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app, isTransientDurableObjectError } from '../supabase/functions/_backend/private/console_data'

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const mocks = vi.hoisted(() => ({ client: vi.fn(), quickError: vi.fn(), stubFetch: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  useCors: async (_c: unknown, next: () => Promise<void>) => next(),
  parseBody: (c: any) => c.req.json(),
  quickError: mocks.quickError,
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('authorization', 'Bearer caller-rls-jwt')
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseClient: mocks.client, emptySupabase: vi.fn() }))

const env = { CONSOLE_EVENTS: { idFromName: (name: string) => name, get: () => ({ fetch: mocks.stubFetch }) } }
const subscribe = () => app.request(`https://api.example.com/events?org_id=${ORG_ID}`, {}, env)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.quickError.mockImplementation((status: number, error: string) => Response.json({ error }, { status }))
  mocks.client.mockReturnValue({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: ORG_ID }, error: null }) }) }) }) })
})

describe('console events stream', () => {
  it('relays the durable object stream', async () => {
    mocks.stubFetch.mockResolvedValue(new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const response = await subscribe()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: {}\n\n')
  })

  it('answers a dropped durable object connection with a retryable 503 and no alert', async () => {
    const dropped = new Error('Network connection lost.')
    mocks.stubFetch.mockRejectedValue(dropped)
    const response = await subscribe()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'events_retryable' })
    expect(mocks.quickError).toHaveBeenCalledWith(503, 'events_retryable', expect.any(String), { retryAfterSeconds: 1 }, dropped, { alert: false })
  })

  it('lets other durable object failures reach the error handler', async () => {
    mocks.stubFetch.mockRejectedValue(new Error('boom'))
    const response = await subscribe()
    expect(response.status).toBe(500)
    expect(mocks.quickError).not.toHaveBeenCalled()
  })
})

describe('isTransientDurableObjectError', () => {
  it.each([
    [new Error('Network connection lost.'), true],
    [Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true }), true],
    [new Error('boom'), false],
    ['Network connection lost.', false],
    [null, false],
  ])('classifies %o as %s', (error, expected) => {
    expect(isTransientDurableObjectError(error)).toBe(expected)
  })
})
