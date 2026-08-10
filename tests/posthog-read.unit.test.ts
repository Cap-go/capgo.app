import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryPosthogHogql } from '../supabase/functions/_backend/utils/posthog_read.ts'

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: vi.fn((c: Context) => (c as Context & { env?: Record<string, string | undefined> }).env ?? {}),
  }
})

function context(environment: Record<string, string | undefined> = {}): Context {
  return {
    env: environment,
    get: vi.fn((key: string) => key === 'requestId' ? 'test-request' : undefined),
  } as unknown as Context
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('postHog read transport', () => {
  it('does not fetch when the read key is unconfigured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryPosthogHogql(context(), 'SELECT 1')).resolves.toEqual({
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps successful columns and results to row objects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      columns: ['org_id', 'opens'],
      results: [['org-a', 3]],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryPosthogHogql(context({ POSTHOG_READ_KEY: ' read-key ' }), 'SELECT org_id, opens')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ org_id: 'org-a', opens: 3 }],
    })
    expect(fetchMock).toHaveBeenCalledWith('https://eu.posthog.com/api/projects/22029/query/', expect.objectContaining({
      method: 'POST',
      headers: { 'Authorization': 'Bearer read-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: 'SELECT org_id, opens' } }),
      signal: expect.any(AbortSignal),
    }))
  })

  it('reports PostHog HTTP failures as unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    await expect(queryPosthogHogql(context({ POSTHOG_READ_KEY: 'read-key' }), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: false,
      failureReason: 'unavailable',
      rows: [],
    })
  })

  it('reports TimeoutError failures as timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError))

    await expect(queryPosthogHogql(context({ POSTHOG_READ_KEY: 'read-key' }), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: false,
      failureReason: 'timeout',
      rows: [],
    })
  })
})
