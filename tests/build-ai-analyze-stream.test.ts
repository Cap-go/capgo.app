// tests/build-ai-analyze-stream.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiAnalyzeStreamBuild } from '../supabase/functions/_backend/public/build/ai_analyze_stream'

const { mockRlsQuery, mockAdminQuery, mockCheckPermission, mockGetEnv, mockSendEventToTracking } = vi.hoisted(() => ({
  mockRlsQuery: vi.fn(),
  mockAdminQuery: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockGetEnv: vi.fn(),
  mockSendEventToTracking: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mockRlsQuery }),
  }
})
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({ query: mockAdminQuery }),
  closeClient: () => {},
}))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mockCheckPermission }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ getEnv: mockGetEnv }))
vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({ sendEventToTracking: mockSendEventToTracking }))

const jobId = 'job-abc'
const appId = 'com.test.ai.stream'
const orgId = 'org-test-1'
const apikey = { key: 'apikey-test', user_id: 'user-1' } as any

// waitUntil-captured promises so tests can await background work deterministically.
let waitUntilPromises: Promise<unknown>[]

function createContext() {
  waitUntilPromises = []
  return {
    req: { raw: new Request('http://localhost/build/ai_analyze_stream', { method: 'POST' }) },
    get: vi.fn().mockImplementation((key: string) => key === 'requestId' ? 'req-test' : undefined),
    json: vi.fn().mockImplementation((data: unknown, status: number) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })),
    executionCtx: { waitUntil: (p: Promise<unknown>) => { waitUntilPromises.push(p) } },
  } as any
}

interface MockDbOpts {
  row?: { app_id: string, status: string, owner_org: string } | null
  claimRows?: Array<{ builder_job_id: string }>
}

// Wires the API-key RLS SELECT and the admin claim/refund UPDATE.
// Claim: SET ai_analyzed = true ... AND ai_analyzed = false. Refund: SET ai_analyzed = false.
function mockDb(opts: MockDbOpts = {}) {
  const row = opts.row === undefined ? { app_id: appId, status: 'failed', owner_org: orgId } : opts.row
  mockRlsQuery.mockResolvedValue({ rows: row ? [{ row }] : [] })

  const claimRows = opts.claimRows ?? [{ builder_job_id: jobId }]
  const updateCalls: Array<Record<string, unknown>> = []
  const adminUpdate = mockAdminQuery.mockImplementation(async (text: string, params: unknown[]) => {
    const value = params[2] as boolean
    updateCalls.push({ ai_analyzed: value })
    if (value)
      expect(text).toContain('AND ai_analyzed = false')
    const rows = value ? claimRows : [{ builder_job_id: jobId }]
    return { rows, rowCount: rows.length }
  })
  return { adminUpdate, updateCalls }
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
}

async function readAll(res: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))
}

function resultEvents() {
  return mockSendEventToTracking.mock.calls
    .filter(([, p]) => p.event === 'AI Build Analysis Result')
    .map(([, p]) => p.tags.result)
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockRlsQuery.mockReset()
  mockAdminQuery.mockReset()
  mockCheckPermission.mockReset()
  mockGetEnv.mockReset()
  mockSendEventToTracking.mockReset()
  mockSendEventToTracking.mockResolvedValue(undefined)
  mockCheckPermission.mockResolvedValue(true)
  mockGetEnv.mockImplementation((_: unknown, key: string) =>
    key === 'BUILDER_URL' ? 'https://builder.test' : key === 'BUILDER_API_KEY' ? 'builder-key' : '')
  globalThis.fetch = vi.fn()
})

describe('aiAnalyzeStreamBuild', () => {
  it('claims the flag BEFORE calling the builder, with the conditional ai_analyzed=false guard', async () => {
    const { adminUpdate } = mockDb()
    const order: string[] = []
    adminUpdate.mockImplementationOnce(async (text: string, params: unknown[]) => {
      order.push('claim')
      expect(text).toContain('SET ai_analyzed = $3')
      expect(text).toContain('AND ai_analyzed = false')
      expect(params).toEqual([jobId, appId, true])
      return { rows: [{ builder_job_id: jobId }], rowCount: 1 }
    })
    ;(globalThis.fetch as any).mockImplementation(() => {
      order.push('fetch')
      return Promise.resolve(new Response(sseBody(['event: chunk\ndata: {"text":"x"}\n\n', 'event: done\ndata: {"durationMs":1}\n\n']),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    })
    const res = await aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')
    expect(order).toEqual(['claim', 'fetch'])
    expect(res.status).toBe(200)
  })

  it('returns 409 when the claim affects 0 rows, and never calls the builder', async () => {
    mockDb({ claimRows: [] })
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs'))
      .rejects.toMatchObject({ status: 409 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(resultEvents()).toContain('already_analyzed')
  })

  it('pipes the builder SSE through verbatim and emits success telemetry', async () => {
    mockDb()
    ;(globalThis.fetch as any).mockResolvedValue(new Response(
      sseBody(['event: chunk\ndata: {"text":"hello"}\n\n', 'event: done\ndata: {"durationMs":5}\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const res = await aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const body = await readAll(res)
    expect(body).toBe('event: chunk\ndata: {"text":"hello"}\n\nevent: done\ndata: {"durationMs":5}\n\n')
    await Promise.all(waitUntilPromises)
    expect(resultEvents()).toContain('success')
  })

  it('refunds on connection failure (fetch throws non-abort) and reports 502', async () => {
    const { updateCalls } = mockDb()
    ;(globalThis.fetch as any).mockRejectedValue(new TypeError('fetch failed'))
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs'))
      .rejects.toMatchObject({})
    expect(updateCalls).toEqual([{ ai_analyzed: true }, { ai_analyzed: false }])
    expect(resultEvents()).toContain('refunded')
  })

  it('refunds when the builder answers non-200 with aiStarted: false', async () => {
    const { updateCalls } = mockDb()
    ;(globalThis.fetch as any).mockResolvedValue(new Response(
      JSON.stringify({ error: 'logs_too_big', aiStarted: false }), { status: 400 }))
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')).rejects.toMatchObject({})
    expect(updateCalls).toEqual([{ ai_analyzed: true }, { ai_analyzed: false }])
    expect(resultEvents()).toContain('refunded')
  })

  it('does NOT refund when the builder answers non-200 with aiStarted: true', async () => {
    const { updateCalls } = mockDb()
    ;(globalThis.fetch as any).mockResolvedValue(new Response(
      JSON.stringify({ error: 'ai_error', aiStarted: true }), { status: 502 }))
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')).rejects.toMatchObject({})
    expect(updateCalls).toEqual([{ ai_analyzed: true }])
    expect(resultEvents()).toContain('builder_error')
  })

  it('does NOT refund when the builder error body is malformed (fail closed)', async () => {
    const { updateCalls } = mockDb()
    ;(globalThis.fetch as any).mockResolvedValue(new Response('nonsense', { status: 500 }))
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')).rejects.toMatchObject({})
    expect(updateCalls).toEqual([{ ai_analyzed: true }])
  })

  it('does NOT refund on abort/timeout fetch failures (fail closed)', async () => {
    const { updateCalls } = mockDb()
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    ;(globalThis.fetch as any).mockRejectedValue(abortErr)
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')).rejects.toMatchObject({})
    expect(updateCalls).toEqual([{ ai_analyzed: true }])
  })

  it('converts a mid-stream upstream failure into an in-band error event, no refund', async () => {
    const { updateCalls } = mockDb()
    const encoder = new TextEncoder()
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: chunk\ndata: {"text":"par"}\n\n'))
      },
      // error() in start() would reset the queue and discard the chunk (WHATWG
      // streams spec) — erroring on the next pull delivers chunk-then-failure.
      pull(controller) {
        controller.error(new Error('upstream died'))
      },
    })
    ;(globalThis.fetch as any).mockResolvedValue(new Response(failing, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const res = await aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')
    const body = await readAll(res)
    expect(body).toContain('event: chunk\ndata: {"text":"par"}\n\n')
    expect(body).toContain('event: error\ndata: {"code":"ai_error"}\n\n')
    await Promise.all(waitUntilPromises)
    expect(updateCalls).toEqual([{ ai_analyzed: true }])
    expect(resultEvents()).toContain('mid_stream_error')
  })

  it('rejects invalid_state without claiming when build is not failed', async () => {
    const { updateCalls } = mockDb({ row: { app_id: appId, status: 'running', owner_org: orgId } })
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')).rejects.toMatchObject({})
    expect(updateCalls).toEqual([])
    expect(resultEvents()).toContain('invalid_state')
  })

  it('throws config_error before claiming when BUILDER_URL is missing', async () => {
    const { updateCalls } = mockDb()
    mockGetEnv.mockReturnValue('')
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, 'logs')).rejects.toMatchObject({})
    expect(updateCalls).toEqual([])
    expect(resultEvents()).toContain('config_error')
  })

  it('throws 413 logs_too_big for oversized logs without claiming or calling the builder', async () => {
    const { updateCalls } = mockDb()
    const oversized = 'x'.repeat(10 * 1024 * 1024 + 1)
    await expect(aiAnalyzeStreamBuild(createContext(), jobId, appId, apikey, oversized))
      .rejects.toMatchObject({ status: 413 })
    expect(updateCalls).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(resultEvents()).toContain('logs_too_big')
  })
})
