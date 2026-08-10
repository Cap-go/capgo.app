import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { envState, fetchMock } = vi.hoisted(() => ({
  envState: {} as Record<string, string | undefined>,
  fetchMock: vi.fn(),
}))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: vi.fn((c: Context) => (c as Context & { env?: Record<string, string | undefined> }).env ?? envState),
  }
})

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as Context
}

beforeEach(() => {
  Object.keys(envState).forEach(key => delete envState[key])
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('queryPosthogHogql', () => {
  it('returns unconfigured without calling fetch when POSTHOG_READ_KEY is missing', async () => {
    const { queryPosthogHogql } = await import('../supabase/functions/_backend/utils/posthog_read.ts')

    await expect(queryPosthogHogql(createContext(), 'SELECT 1')).resolves.toEqual({
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps successful HogQL columns and results into rows', async () => {
    envState.POSTHOG_READ_KEY = 'read-key'
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      columns: ['org_id', 'count'],
      results: [['org-1', 2]],
    }), { status: 200 }))
    const { queryPosthogHogql } = await import('../supabase/functions/_backend/utils/posthog_read.ts')

    await expect(queryPosthogHogql(createContext(), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ org_id: 'org-1', count: 2 }],
    })
  })

  it('returns unavailable for a non-success response', async () => {
    envState.POSTHOG_READ_KEY = 'read-key'
    fetchMock.mockResolvedValue(new Response('failure', { status: 503 }))
    const { queryPosthogHogql } = await import('../supabase/functions/_backend/utils/posthog_read.ts')

    await expect(queryPosthogHogql(createContext(), 'SELECT 1')).resolves.toMatchObject({
      configured: true,
      connected: false,
      failureReason: 'unavailable',
      rows: [],
    })
  })

  it('returns timeout when fetch raises TimeoutError', async () => {
    envState.POSTHOG_READ_KEY = 'read-key'
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    const { queryPosthogHogql } = await import('../supabase/functions/_backend/utils/posthog_read.ts')

    await expect(queryPosthogHogql(createContext(), 'SELECT 1')).resolves.toMatchObject({
      configured: true,
      connected: false,
      failureReason: 'timeout',
      rows: [],
    })
  })

  it('returns unavailable for malformed JSON', async () => {
    envState.POSTHOG_READ_KEY = 'read-key'
    fetchMock.mockResolvedValue(new Response('{', { status: 200 }))
    const { queryPosthogHogql } = await import('../supabase/functions/_backend/utils/posthog_read.ts')

    await expect(queryPosthogHogql(createContext(), 'SELECT 1')).resolves.toMatchObject({
      configured: true,
      connected: false,
      failureReason: 'unavailable',
      rows: [],
    })
  })
})
