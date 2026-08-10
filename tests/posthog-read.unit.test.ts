import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPosthogReadConfigured, MAX_POSTHOG_RESPONSE_BYTES, queryPosthogHogql } from '../supabase/functions/_backend/utils/posthog_read.ts'

const EXPECTED_MAX_POSTHOG_RESPONSE_BYTES = 8 * 1024 * 1024

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

function posthogEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    POSTHOG_READ_KEY: 'read-key',
    POSTHOG_READ_HOST: 'https://eu.posthog.com',
    POSTHOG_READ_PROJECT_ID: '22029',
    ...overrides,
  }
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

  it.each([
    ['key', posthogEnv({ POSTHOG_READ_KEY: '' })],
    ['host override without project', posthogEnv({ POSTHOG_READ_PROJECT_ID: '' })],
    ['project override without host', posthogEnv({ POSTHOG_READ_HOST: '' })],
  ])('does not fetch when the %s part of the read configuration is missing', async (_missing, environment) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryPosthogHogql(context(environment), 'SELECT 1')).resolves.toEqual({
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    })
    expect(isPosthogReadConfigured(context(environment))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves the established production defaults for a key-only configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ columns: [], results: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const environment = { POSTHOG_READ_KEY: ' read-key ' }

    expect(isPosthogReadConfigured(context(environment))).toBe(true)
    await expect(queryPosthogHogql(context(environment), 'SELECT 1')).resolves.toMatchObject({
      configured: true,
      connected: true,
      failureReason: null,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://eu.posthog.com/api/projects/22029/query/', expect.anything())
  })

  it('maps successful columns and results to row objects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      columns: ['org_id', 'opens'],
      results: [['org-a', 3]],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(isPosthogReadConfigured(context(posthogEnv()))).toBe(true)
    await expect(queryPosthogHogql(context(posthogEnv({
      POSTHOG_READ_KEY: ' read-key ',
      POSTHOG_READ_HOST: ' https://eu.posthog.com/ ',
      POSTHOG_READ_PROJECT_ID: ' 22029 ',
    })), 'SELECT org_id, opens')).resolves.toEqual({
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

  it('accepts a response body exactly at the byte ceiling', async () => {
    const payload = JSON.stringify({ columns: ['value'], results: [['ok']] })
    const body = `${payload}${' '.repeat(EXPECTED_MAX_POSTHOG_RESPONSE_BYTES - payload.length)}`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    expect(MAX_POSTHOG_RESPONSE_BYTES).toBe(EXPECTED_MAX_POSTHOG_RESPONSE_BYTES)
    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ value: 'ok' }],
    })
  })

  it('enforces a smaller caller response budget without reducing the default budget', async () => {
    const callerBudget = MAX_POSTHOG_RESPONSE_BYTES / 4
    const payload = JSON.stringify({ columns: [], results: [] })
    const body = `${payload}${' '.repeat(callerBudget + 1 - payload.length)}`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1', { maxResponseBytes: callerBudget })).resolves.toMatchObject({
      connected: true,
      failureReason: 'too_large',
      rows: [],
    })
    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1')).resolves.toMatchObject({
      connected: true,
      failureReason: null,
      rows: [],
    })
  })

  it('rejects an oversized declared response before reading its body', async () => {
    let bodyRead = false
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(EXPECTED_MAX_POSTHOG_RESPONSE_BYTES + 1) }),
      get body() {
        bodyRead = true
        throw new Error('oversized body should not be read')
      },
      json: async () => {
        bodyRead = true
        return { columns: [], results: [] }
      },
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: 'too_large',
      rows: [],
    })
    expect(bodyRead).toBe(false)
  })

  it('cancels a chunked response as soon as it crosses the byte ceiling', async () => {
    const chunks = [
      new Uint8Array(EXPECTED_MAX_POSTHOG_RESPONSE_BYTES / 2),
      new Uint8Array(EXPECTED_MAX_POSTHOG_RESPONSE_BYTES / 2 + 1),
    ]
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk)
          controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: true,
      failureReason: 'too_large',
      rows: [],
    })
    expect(cancelled).toBe(true)
  })

  it('reports PostHog HTTP failures as unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1')).resolves.toEqual({
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

    await expect(queryPosthogHogql(context(posthogEnv()), 'SELECT 1')).resolves.toEqual({
      configured: true,
      connected: false,
      failureReason: 'timeout',
      rows: [],
    })
  })
})
