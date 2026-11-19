# Streaming AI Build Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timeout-prone buffered AI build-analysis call with SSE streaming end-to-end, claim-then-refund `ai_analyzed` semantics, and a hard-deprecated old endpoint that tells users to upgrade the CLI.

**Architecture:** Three components in rollout order: (1) `capgo_builder` worker gains an Accept-gated streaming path that normalizes Workers AI SSE into a `chunk`/`done`/`error` event protocol and marks pre-stream errors with `aiStarted`; (2) the capgo edge function gets a new `/build/ai_analyze_stream` route that atomically claims the `ai_analyzed` flag *before* calling the builder, refunds only on provably-pre-AI failures, and pipes the SSE through with first-byte/idle watchdogs — while the old `/build/ai_analyze` becomes a static 426 responder; (3) the CLI consumes the stream with progressive TTY rendering and CI buffering.

**Spec:** `docs/superpowers/specs/2026-06-05-ai-analyze-streaming-design.md` (same worktree). Read it first.

**Tech Stack:** Cloudflare Workers (builder + capgo API), Hono, Supabase JS (Postgres), Workers AI (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`), vitest (builder + capgo), bun `.mjs` scripts (CLI tests), TypeScript.

**Repos / working copies:**
- `capgo` — this worktree (`.claude/worktrees/ai-analyze-streaming-spec`). Tests: `bunx vitest run tests/<file>` from repo root; CLI tests: `cd cli && bun test/<file>.mjs`.
- `capgo_builder` — local checkout at `~/Developer/capgo_builder_new` (remote `Cap-go/capgo_builder`). It is **behind origin** — Task 1 syncs it. Tests: `bun run test` (vitest).

**SSE protocol (shared contract — keep these exact shapes in all three components):**

```text
event: chunk
data: {"text":"<delta>"}

event: done
data: {"durationMs":48211}

event: error
data: {"code":"ai_error" | "idle_timeout"}
```

Pre-stream builder errors: `{ "error": "<code>", "aiStarted": true|false }` JSON.
Deprecated endpoint body: `{ "error": "AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest", "code": "upgrade_required" }` with status 426 — the human text MUST be in `error` (deployed CLIs print `body.error || body.message`).

---

## Phase A — capgo_builder

### Task 1: Sync builder repo and branch

**Files:** none (git only)

- [ ] **Step 1: Pull main and create a feature branch**

```bash
cd ~/Developer/capgo_builder_new
git checkout main && git pull origin main
git checkout -b feat/ai-analyze-streaming
bun install
bun run test
```

Expected: all existing tests pass (baseline green, including `test/ai-analyze-handler.test.ts`).

### Task 2: SSE normalizer module (builder)

**Files:**
- Create: `~/Developer/capgo_builder_new/src/ai-analyze-sse.ts`
- Test: `~/Developer/capgo_builder_new/test/ai-analyze-sse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ai-analyze-sse.test.ts
import { describe, expect, it } from 'vitest'
import { createSseNormalizer, extractDeltaText, sseFrame } from '../src/ai-analyze-sse'

function workersAiStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

describe('sseFrame', () => {
  it('formats an SSE frame', () => {
    expect(sseFrame('chunk', { text: 'hi' })).toBe('event: chunk\ndata: {"text":"hi"}\n\n')
  })
})

describe('extractDeltaText', () => {
  it('reads CF-native {response} shape', () => {
    expect(extractDeltaText({ response: 'tok' })).toBe('tok')
  })
  it('reads OpenAI-compat delta shape', () => {
    expect(extractDeltaText({ choices: [{ delta: { content: 'tok' } }] })).toBe('tok')
  })
  it('reads OpenAI-compat text shape', () => {
    expect(extractDeltaText({ choices: [{ text: 'tok' }] })).toBe('tok')
  })
  it('returns empty string for unknown shapes', () => {
    expect(extractDeltaText({ usage: {} })).toBe('')
    expect(extractDeltaText(null)).toBe('')
  })
})

describe('createSseNormalizer', () => {
  it('normalizes Workers AI frames into chunk events and appends done', async () => {
    const upstream = workersAiStream([
      'data: {"response":"Hello"}\n\n',
      'data: {"response":" world"}\n\ndata: [DONE]\n\n',
    ])
    const out = await collect(upstream.pipeThrough(createSseNormalizer(Date.now())))
    expect(out).toContain('event: chunk\ndata: {"text":"Hello"}\n\n')
    expect(out).toContain('event: chunk\ndata: {"text":" world"}\n\n')
    expect(out).toMatch(/event: done\ndata: \{"durationMs":\d+\}\n\n$/)
  })

  it('handles a data line split across network chunks', async () => {
    const upstream = workersAiStream(['data: {"resp', 'onse":"split"}\n\n'])
    const out = await collect(upstream.pipeThrough(createSseNormalizer(Date.now())))
    expect(out).toContain('event: chunk\ndata: {"text":"split"}\n\n')
  })

  it('emits error (not done) when no text was produced', async () => {
    const upstream = workersAiStream(['data: [DONE]\n\n'])
    const out = await collect(upstream.pipeThrough(createSseNormalizer(Date.now())))
    expect(out).toContain('event: error\ndata: {"code":"ai_error"}\n\n')
    expect(out).not.toContain('event: done')
  })

  it('ignores unparsable keep-alive lines', async () => {
    const upstream = workersAiStream([': keep-alive\n\n', 'data: {"response":"ok"}\n\n'])
    const out = await collect(upstream.pipeThrough(createSseNormalizer(Date.now())))
    expect(out).toContain('event: chunk\ndata: {"text":"ok"}\n\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Developer/capgo_builder_new && bunx vitest run test/ai-analyze-sse.test.ts`
Expected: FAIL — `Cannot find module '../src/ai-analyze-sse'`

- [ ] **Step 3: Write the implementation**

```ts
// src/ai-analyze-sse.ts
// Normalizes a Workers AI streaming body (OpenAI-style SSE) into the capgo
// AI-analyze SSE protocol consumed by the capgo edge fn and the CLI:
//   event: chunk  data: {"text":"<delta>"}
//   event: done   data: {"durationMs":N}      (normal end, at least one chunk)
//   event: error  data: {"code":"ai_error"}   (stream ended with no text)
// Workers AI frames look like:
//   data: {"response":"tok"}                          (CF-native models)
//   data: {"choices":[{"delta":{"content":"tok"}}]}   (OpenAI-compat models)
//   data: [DONE]

const encoder = new TextEncoder()

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function extractDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const rec = parsed as Record<string, unknown>
  if (typeof rec.response === 'string') return rec.response
  const choices = rec.choices
  const choice = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined
  if (!choice) return ''
  const delta = choice.delta as Record<string, unknown> | undefined
  if (typeof delta?.content === 'string') return delta.content
  if (typeof choice.text === 'string') return choice.text
  return ''
}

export function createSseNormalizer(startedAt: number): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  let emittedAny = false

  function handleLine(line: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return // terminal frame emitted on flush instead
    try {
      const text = extractDeltaText(JSON.parse(payload))
      if (text) {
        emittedAny = true
        controller.enqueue(encoder.encode(sseFrame('chunk', { text })))
      }
    }
    catch {
      // Unparsable line (keep-alive, partial vendor frame) — skip, never break the stream.
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line, controller)
    },
    flush(controller) {
      if (buffer) handleLine(buffer, controller)
      if (emittedAny)
        controller.enqueue(encoder.encode(sseFrame('done', { durationMs: Date.now() - startedAt })))
      else
        controller.enqueue(encoder.encode(sseFrame('error', { code: 'ai_error' })))
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Developer/capgo_builder_new && bunx vitest run test/ai-analyze-sse.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/capgo_builder_new
git add src/ai-analyze-sse.ts test/ai-analyze-sse.test.ts
git commit -m "feat(ai-analyze): SSE normalizer for streaming analysis protocol"
```

### Task 3: Streaming path + aiStarted markers in handleAiAnalyze (builder)

**Files:**
- Modify: `~/Developer/capgo_builder_new/src/ai-analyze.ts`
- Test: `~/Developer/capgo_builder_new/test/ai-analyze-handler.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (append to the existing `describe('handleAiAnalyze')` block; reuse the file's `makeRequest`/`makeEnv` helpers, adding a streaming request helper)

```ts
// append to test/ai-analyze-handler.test.ts

function makeStreamRequest(body: unknown, apiKey = 'test-key'): Request {
  return new Request('http://test/jobs/job-abc/ai-analyze', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'accept': 'text/event-stream' },
    body: JSON.stringify(body),
  })
}

function aiSseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

async function readAll(res: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))
}

describe('handleAiAnalyze streaming', () => {
  it('streams normalized SSE when Accept: text/event-stream', async () => {
    const req = makeStreamRequest({ logs: 'small log content' })
    const env = {
      WORKER_API_KEY: 'test-key',
      AI: { run: vi.fn().mockResolvedValue(aiSseStream(['data: {"response":"diag"}\n\n', 'data: [DONE]\n\n'])) },
    }
    const res = await handleAiAnalyze(req, env as any, 'job-abc')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(env.AI.run).toHaveBeenCalledWith('@cf/deepseek-ai/deepseek-v4.1-flash-1017', expect.objectContaining({ stream: true }))
    const body = await readAll(res)
    expect(body).toContain('event: chunk\ndata: {"text":"diag"}\n\n')
    expect(body).toContain('event: done')
  })

  it('falls back to a synthetic single-chunk stream when the model ignores stream:true', async () => {
    const req = makeStreamRequest({ logs: 'small log content' })
    const env = makeEnv({ response: 'full analysis text' }) // resolves a plain object, not a stream
    const res = await handleAiAnalyze(req, env as any, 'job-abc')
    expect(res.status).toBe(200)
    const body = await readAll(res)
    expect(body).toContain('event: chunk\ndata: {"text":"full analysis text"}\n\n')
    expect(body).toContain('event: done')
  })

  it('marks aiStarted: true when AI.run throws on the streaming path', async () => {
    const req = makeStreamRequest({ logs: 'hi' })
    const env = { WORKER_API_KEY: 'test-key', AI: { run: vi.fn().mockRejectedValue(new Error('boom')) } }
    const res = await handleAiAnalyze(req, env as any, 'job-abc')
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string, aiStarted: boolean }
    expect(body).toEqual({ error: 'ai_error', aiStarted: true })
  })

  it('marks aiStarted: false on validation failures (buffered and streaming)', async () => {
    for (const make of [makeRequest, makeStreamRequest]) {
      const res = await handleAiAnalyze(make({}), makeEnv() as any, 'job-abc')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string, aiStarted: boolean }
      expect(body).toEqual({ error: 'invalid_json', aiStarted: false })
    }
  })

  it('marks aiStarted: false on logs_too_big', async () => {
    const res = await handleAiAnalyze(makeRequest({ logs: 'x'.repeat(10 * 1024 * 1024 + 1) }), makeEnv() as any, 'job-abc')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string, aiStarted: boolean }
    expect(body).toEqual({ error: 'logs_too_big', aiStarted: false })
  })
})
```

Also update the two existing assertions that check exact error bodies (`invalid_json`, `logs_too_big`, `ai_error` tests) to expect the added `aiStarted` field — they assert via `body.error`, which still passes, but the malformed-shape test at ~line 96 asserts a 502 body: extend its expectation to `expect(body.aiStarted).toBe(true)`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd ~/Developer/capgo_builder_new && bunx vitest run test/ai-analyze-handler.test.ts`
Expected: new tests FAIL (no streaming path, no `aiStarted` field); existing tests still pass.

- [ ] **Step 3: Implement** — in `src/ai-analyze.ts`:

(a) add import: `import { createSseNormalizer, sseFrame } from './ai-analyze-sse'`

(b) replace each error return with a marker body:
- `return errorResponse('invalid_json', 400)` (both occurrences) → `return jsonResponse({ error: 'invalid_json', aiStarted: false }, { status: 400 })`
- `return errorResponse('logs_too_big', 400)` → `return jsonResponse({ error: 'logs_too_big', aiStarted: false }, { status: 400 })`
- both `return jsonResponse({ error: 'ai_error' }, { status: 502 })` → `return jsonResponse({ error: 'ai_error', aiStarted: true }, { status: 502 })`

(`requireApiKey`'s 401 stays untouched — it carries no marker, and the edge fn fails closed on unmarked errors, which is the right direction for an auth/config bug.)

(c) insert the streaming path between the `debugLog('ai-analyze:trim', ...)` call and the existing `const start = Date.now()`:

```ts
  const wantsStream = (request.headers.get('accept') ?? '').includes('text/event-stream')
  const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

  if (wantsStream) {
    const startStream = Date.now()
    let aiResult: unknown
    try {
      aiResult = await env.AI.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `<BUILD_LOG>\n${trimResult.trimmed}\n</BUILD_LOG>` },
        ],
        stream: true,
      })
    }
    catch (err) {
      debugLog('ai-analyze:ai-error', 'AI binding threw (stream)', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      return jsonResponse({ error: 'ai_error', aiStarted: true }, { status: 502 })
    }

    if (aiResult instanceof ReadableStream) {
      return new Response(aiResult.pipeThrough(createSseNormalizer(startStream)), { headers: sseHeaders })
    }

    // Model ignored stream:true — emit the buffered result as a synthetic
    // single-chunk stream so the protocol is identical for consumers.
    const analysis = extractAnalysis(aiResult)
    if (!analysis) {
      debugLog('ai-analyze:ai-malformed', 'AI returned unexpected shape (stream fallback)', { jobId, shape: typeof aiResult })
      return jsonResponse({ error: 'ai_error', aiStarted: true }, { status: 502 })
    }
    debugLog('ai-analyze:success', 'analysis returned (stream fallback)', {
      jobId,
      latencyMs: Date.now() - startStream,
      analysisChars: analysis.length,
    })
    return new Response(
      sseFrame('chunk', { text: analysis }) + sseFrame('done', { durationMs: Date.now() - startStream }),
      { headers: sseHeaders },
    )
  }
```

The existing buffered path below stays unchanged (it is deleted in Task 12 after cutover).

- [ ] **Step 4: Run all builder tests + typecheck**

Run: `cd ~/Developer/capgo_builder_new && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/capgo_builder_new
git add src/ai-analyze.ts test/ai-analyze-handler.test.ts
git commit -m "feat(ai-analyze): Accept-gated SSE streaming + aiStarted cost markers"
```

- [ ] **Step 6: Push and open PR** (do not deploy yet — deploy order is in Task 11)

```bash
git push -u origin feat/ai-analyze-streaming
gh pr create --title "feat(ai-analyze): SSE streaming + aiStarted cost markers" --body "Part 1/3 of streaming AI analysis. Spec: capgo docs/superpowers/specs/2026-06-05-ai-analyze-streaming-design.md. Backward compatible: buffered path unchanged without Accept header."
```

---

## Phase B — capgo edge function (this worktree)

### Task 4: Extract shared telemetry module

**Files:**
- Create: `supabase/functions/_backend/public/build/ai_analyze_telemetry.ts`
- Modify: `supabase/functions/_backend/public/build/ai_analyze.ts` (remove the moved code, import instead)

- [ ] **Step 1: Create the module** — move `AiAnalysisResult`, `EmitAiAnalysisResultInput`, and `emitAiAnalysisResult` out of `ai_analyze.ts` verbatim, extending the enum:

```ts
// supabase/functions/_backend/public/build/ai_analyze_telemetry.ts
import type { Context } from 'hono'
import { cloudlogErr, serializeError } from '../../utils/logging.ts'
import { sendEventToTracking } from '../../utils/tracking.ts'

export type AiAnalysisResult
  = | 'success'
    | 'already_analyzed'
    | 'invalid_state'
    | 'unauthorized'
    | 'builder_error'
    | 'config_error'
    | 'mid_stream_error'
    | 'refunded'
    | 'upgrade_required'

export interface EmitAiAnalysisResultInput {
  appId: string
  jobId: string
  result: AiAnalysisResult
  ownerOrg?: string
  userId: string
  logsBytes: number
  durationMs?: number
}

/**
 * Emit the `AI Build Analysis Result` event for an exit branch.
 *
 * Privacy boundary: the AI diagnosis text from the builder MUST NOT cross into any
 * tag here. Only the closed-enum `result`, size/duration metadata, and stable
 * identifiers are sent. Callers fire this before throwing (or before returning a
 * successful response) so every exit branch produces exactly one Result event.
 */
export async function emitAiAnalysisResult(c: Context, input: EmitAiAnalysisResultInput): Promise<void> {
  const tags: Record<string, string> = {
    app_id: input.appId,
    job_id: input.jobId,
    result: input.result,
    logs_bytes: String(input.logsBytes),
  }
  if (input.ownerOrg)
    tags.org_id = input.ownerOrg
  if (input.durationMs !== undefined && Number.isFinite(input.durationMs))
    tags.duration_ms = String(Math.round(input.durationMs))

  // Telemetry MUST NOT break the AI analyze flow.
  try {
    await sendEventToTracking(c, {
      event: 'AI Build Analysis Result',
      channel: 'build-lifecycle',
      icon: '🤖',
      notify: false,
      user_id: input.userId,
      groups: input.ownerOrg ? { organization: input.ownerOrg } : undefined,
      tags,
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'AI Build Analysis Result telemetry failed',
      result: input.result,
      error: serializeError(error),
    })
  }
}
```

In `ai_analyze.ts`: delete the moved type/interface/function (lines 15–75) and add
`import { emitAiAnalysisResult } from './ai_analyze_telemetry.ts'`.

- [ ] **Step 2: Run the existing test suite to confirm no regression**

Run: `bunx vitest run tests/build-ai-analyze.test.ts`
Expected: PASS (pure extraction; the file mocks `tracking.ts`, which the new module imports the same way).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_backend/public/build/
git commit -m "refactor(build): extract AI analysis telemetry into shared module"
```

### Task 5: New streaming route handler with claim-then-refund

**Files:**
- Create: `supabase/functions/_backend/public/build/ai_analyze_stream.ts`
- Test: `tests/build-ai-analyze-stream.test.ts` (new; copy the harness patterns from `tests/build-ai-analyze.test.ts` — same `vi.hoisted` mocks of `supabase.ts`, `rbac.ts`, `utils.ts`, `tracking.ts`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/build-ai-analyze-stream.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiAnalyzeStreamBuild } from '../supabase/functions/_backend/public/build/ai_analyze_stream'

const { mockSupabaseApikey, mockSupabaseAdmin, mockCheckPermission, mockGetEnv, mockSendEventToTracking } = vi.hoisted(() => ({
  mockSupabaseApikey: vi.fn(),
  mockSupabaseAdmin: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockGetEnv: vi.fn(),
  mockSendEventToTracking: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: mockSupabaseApikey,
  supabaseAdmin: mockSupabaseAdmin,
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

// Wires the user-context SELECT chain and the admin claim/refund UPDATE chain.
// Claim chain: .update({ai_analyzed:true}).eq(jobId).eq(appId).eq('ai_analyzed', false).select(...)
// Refund chain: .update({ai_analyzed:false}).eq(jobId).eq(appId).select(...)
function mockDb(opts: MockDbOpts = {}) {
  const row = opts.row === undefined ? { app_id: appId, status: 'failed', owner_org: orgId } : opts.row
  const eqAppId = { maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }) }
  const eqJob = { eq: vi.fn().mockReturnValue(eqAppId) }
  const select = { eq: vi.fn().mockReturnValue(eqJob) }
  mockSupabaseApikey.mockReturnValue({
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(select) }),
  })

  const claimRows = opts.claimRows ?? [{ builder_job_id: jobId }]
  const updateCalls: Array<Record<string, unknown>> = []
  const adminUpdate = vi.fn().mockImplementation((values: Record<string, unknown>) => {
    updateCalls.push(values)
    // Claim has three .eq() calls; refund has two. Support both via a chain
    // where every .eq() returns the same object and .select() resolves.
    const chain: any = {}
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.select = vi.fn().mockResolvedValue({
      data: values.ai_analyzed === true ? claimRows : [{ builder_job_id: jobId }],
      error: null,
    })
    return chain
  })
  mockSupabaseAdmin.mockReturnValue({ from: vi.fn().mockReturnValue({ update: adminUpdate }) })
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
  mockSupabaseApikey.mockReset()
  mockSupabaseAdmin.mockReset()
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
    adminUpdate.mockImplementationOnce((values: Record<string, unknown>) => {
      order.push('claim')
      const chain: any = {}
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockResolvedValue({ data: [{ builder_job_id: jobId }], error: null })
      expect(values).toEqual({ ai_analyzed: true })
      return chain
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
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/build-ai-analyze-stream.test.ts`
Expected: FAIL — `Cannot find module .../ai_analyze_stream`

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_backend/public/build/ai_analyze_stream.ts
import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlogErr, serializeError } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { sendEventToTracking } from '../../utils/tracking.ts'
import { getEnv } from '../../utils/utils.ts'
import { emitAiAnalysisResult } from './ai_analyze_telemetry.ts'

// Liveness watchdogs replace the old fixed 60s wall-clock timeout. The CLI's
// values (120s/45s) are deliberately larger so this inner layer fires first.
export const FIRST_BYTE_TIMEOUT_MS = 90_000
export const IDLE_TIMEOUT_MS = 30_000

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

export async function aiAnalyzeStreamBuild(
  c: Context,
  jobId: string,
  appId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  logs: string,
): Promise<Response> {
  // Byte-accurate: logs.length counts UTF-16 code units, which undercounts
  // multi-byte UTF-8 — encode once and use real bytes for the guard + telemetry.
  const logsBytes = logs ? new TextEncoder().encode(logs).length : 0

  // 1. Permission check
  if (!(await checkPermission(c, 'app.build_native', { appId }))) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Unauthorized AI analyze (stream)', job_id: jobId, app_id: appId, user_id: apikey.user_id })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'unauthorized', userId: apikey.user_id, logsBytes })
    throw simpleError('unauthorized', 'You do not have permission to analyze this build')
  }

  // 2. Ownership + state check (user context). Idempotency is NOT checked here —
  // the atomic claim below is the only gate, so there is no SELECT-then-flip race.
  const supabase = supabaseApikey(c, apikey.key)
  const { data: row, error: selectErr } = await supabase
    .from('build_requests')
    .select('app_id, status, owner_org')
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .maybeSingle()

  if (selectErr) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to fetch build_request for AI analyze (stream)', job_id: jobId, error: selectErr.message })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', userId: apikey.user_id, logsBytes })
    throw simpleError('internal_error', 'Failed to fetch build request')
  }
  if (!row) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Unauthorized AI analyze (job/app mismatch or missing)', job_id: jobId, app_id: appId, user_id: apikey.user_id })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'unauthorized', userId: apikey.user_id, logsBytes })
    throw simpleError('unauthorized', 'You do not have permission to analyze this build')
  }
  const ownerOrg = row.owner_org
  if (row.status !== 'failed') {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'invalid_state', ownerOrg, userId: apikey.user_id, logsBytes })
    throw simpleError('invalid_state', 'AI analysis only available for failed builds')
  }

  // 3. Config check BEFORE claiming — a missing env var must not consume the slot.
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl || !builderApiKey) {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'config_error', ownerOrg, userId: apikey.user_id, logsBytes })
    throw simpleError('config_error', 'Builder service not configured')
  }

  // 4. CLAIM — atomic conditional flip, service-role client (RLS grants UPDATE to
  // service role only; user-context UPDATE would silently match 0 rows). Claiming
  // BEFORE the builder call is the abuse barrier: Workers AI bills input tokens at
  // prompt submission, so the flag must flip when cost commits, not on delivery.
  const admin = supabaseAdmin(c)
  const { data: claimed, error: claimErr } = await admin
    .from('build_requests')
    .update({ ai_analyzed: true })
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .eq('ai_analyzed', false)
    .select('builder_job_id')

  if (claimErr) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'AI analyze claim failed', job_id: jobId, error: claimErr.message })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes })
    throw simpleError('internal_error', 'Failed to claim analysis slot')
  }
  if (!claimed || claimed.length === 0) {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'already_analyzed', ownerOrg, userId: apikey.user_id, logsBytes })
    // 409 — the CLI branches on res.status === 409 for this case
    throw quickError(409, 'already_analyzed', 'AI analysis already requested for this job')
  }

  // Refund — ONLY for provably-pre-AI failures. Never on disconnects/timeouts.
  const refund = async (reason: string): Promise<void> => {
    const { error: refundErr } = await admin
      .from('build_requests')
      .update({ ai_analyzed: false })
      .eq('builder_job_id', jobId)
      .eq('app_id', appId)
      .select('builder_job_id')
    if (refundErr) {
      // Fail closed: slot stays consumed. Log loudly — this should be rare.
      cloudlogErr({ requestId: c.get('requestId'), message: 'AI analyze refund failed — slot stays consumed', job_id: jobId, reason, error: refundErr.message })
    }
  }

  // Requested telemetry — after the claim so it means "a billable attempt starts".
  try {
    await sendEventToTracking(c, {
      event: 'AI Build Analysis Requested',
      channel: 'build-lifecycle',
      icon: '🤖',
      notify: false,
      user_id: apikey.user_id,
      groups: { organization: ownerOrg },
      tags: { app_id: appId, org_id: ownerOrg, job_id: jobId, logs_bytes: String(logsBytes) },
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'AI Build Analysis Requested telemetry failed', error: serializeError(error) })
  }

  // 5. Call the builder (streaming). One AbortController serves both watchdog
  // phases: armed for first-byte now, re-armed per chunk in the pump below.
  const startedAt = Date.now()
  const controller = new AbortController()
  let watchdog: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)

  let builderResp: Response
  try {
    builderResp = await fetch(`${builderUrl}/jobs/${jobId}/ai-analyze`, {
      method: 'POST',
      headers: { 'x-api-key': builderApiKey, 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({ logs }),
      signal: controller.signal,
    })
  }
  catch (err) {
    clearTimeout(watchdog)
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    if (!aborted) {
      // Request never reached the builder — provably zero AI cost. Refund.
      await refund('connection_failure')
      await emitAiAnalysisResult(c, { appId, jobId, result: 'refunded', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
      throw simpleError('builder_error', 'AI analysis request failed — please retry')
    }
    // Watchdog fired pre-headers: ambiguous (AI may be ingesting). Fail closed.
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    throw simpleError('builder_error', 'AI analysis timed out')
  }

  if (!builderResp.ok) {
    clearTimeout(watchdog)
    const errBody = await builderResp.json().catch(() => null) as { error?: string, aiStarted?: boolean } | null
    if (errBody?.aiStarted === false) {
      // Builder rejected before invoking env.AI.run — provably zero AI cost. Refund.
      await refund(`builder_${errBody.error ?? 'error'}`)
      await emitAiAnalysisResult(c, { appId, jobId, result: 'refunded', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
      throw simpleError('builder_error', 'AI analysis failed before starting — please retry')
    }
    // aiStarted true / missing / malformed — billing unknown. Fail closed.
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder AI analyze failed (stream)', job_id: jobId, status: builderResp.status, error: errBody?.error ?? '<unparsable>' })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    throw simpleError('builder_error', 'AI analysis failed')
  }

  if (!builderResp.body) {
    clearTimeout(watchdog)
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    throw simpleError('builder_error', 'AI analysis returned no stream')
  }

  // 6. Pump the builder stream to the client, resetting the idle watchdog per
  // chunk. Upstream failure (watchdog abort or builder stream error) becomes an
  // in-band `event: error` — the HTTP status is already committed. The pump runs
  // under waitUntil so the telemetry write survives client disconnects.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const pump = (async () => {
    const reader = builderResp.body!.getReader()
    let result: 'success' | 'mid_stream_error' = 'success'
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        clearTimeout(watchdog)
        watchdog = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
        await writer.write(value)
      }
    }
    catch (err) {
      // No refund here ever: the AI run was in progress. Slot stays consumed.
      result = 'mid_stream_error'
      const code = controller.signal.aborted ? 'idle_timeout' : 'ai_error'
      cloudlogErr({ requestId: c.get('requestId'), message: 'AI analyze stream interrupted', job_id: jobId, code, error: serializeError(err) })
      await writer.write(encoder.encode(`event: error\ndata: {"code":"${code}"}\n\n`)).catch(() => {})
    }
    finally {
      clearTimeout(watchdog)
      await writer.close().catch(() => {})
      await emitAiAnalysisResult(c, { appId, jobId, result, ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    }
  })()

  try {
    c.executionCtx.waitUntil(pump)
  }
  catch {
    // executionCtx unavailable (tests) — pump still runs as a floating promise.
  }

  return new Response(readable, { headers: SSE_HEADERS })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/build-ai-analyze-stream.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_backend/public/build/ai_analyze_stream.ts tests/build-ai-analyze-stream.test.ts
git commit -m "feat(build): streaming AI analyze route with claim-then-refund slot semantics"
```

### Task 6: Deprecate the old endpoint (426 responder)

**Files:**
- Modify: `supabase/functions/_backend/public/build/ai_analyze.ts` (gut the proxy; keep only the deprecated responder)
- Test: `tests/build-ai-analyze.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test file**

```ts
// tests/build-ai-analyze.test.ts — the old proxy is gone; this now regression-
// tests the permanent 426 deprecation responder.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UPGRADE_MESSAGE, aiAnalyzeDeprecated } from '../supabase/functions/_backend/public/build/ai_analyze'

const { mockSendEventToTracking } = vi.hoisted(() => ({ mockSendEventToTracking: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({ sendEventToTracking: mockSendEventToTracking }))

const apikey = { key: 'apikey-test', user_id: 'user-1' } as any

function createContext(body?: unknown) {
  return {
    req: {
      raw: new Request('http://localhost/build/ai_analyze', {
        method: 'POST',
        body: body === undefined ? null : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    },
    get: vi.fn().mockImplementation((key: string) => key === 'requestId' ? 'req-test' : undefined),
    json: vi.fn().mockImplementation((data: unknown, status: number) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })),
  } as any
}

beforeEach(() => {
  mockSendEventToTracking.mockReset()
  mockSendEventToTracking.mockResolvedValue(undefined)
  globalThis.fetch = vi.fn()
})

describe('aiAnalyzeDeprecated', () => {
  it('returns 426 with the upgrade text in the error field (body.error wins over body.message in old CLIs)', async () => {
    const res = await aiAnalyzeDeprecated(createContext({ jobId: 'j', appId: 'a', logs: 'x' }), apikey)
    expect(res.status).toBe(426)
    const body = await res.json() as { error: string, code: string }
    expect(body.error).toBe(UPGRADE_MESSAGE)
    expect(body.error).toContain('npx @capgo/cli@latest')
    expect(body.code).toBe('upgrade_required')
  })

  it('answers 426 even with an unparsable body', async () => {
    const res = await aiAnalyzeDeprecated(createContext(), apikey)
    expect(res.status).toBe(426)
  })

  it('never contacts the builder or the database', async () => {
    await aiAnalyzeDeprecated(createContext({ jobId: 'j', appId: 'a', logs: 'x' }), apikey)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('emits upgrade_required telemetry with best-effort job/app tags', async () => {
    await aiAnalyzeDeprecated(createContext({ jobId: 'job-1', appId: 'app-1', logs: 'x' }), apikey)
    const calls = mockSendEventToTracking.mock.calls.filter(([, p]) => p.event === 'AI Build Analysis Result')
    expect(calls).toHaveLength(1)
    expect(calls[0][1].tags.result).toBe('upgrade_required')
    expect(calls[0][1].tags.job_id).toBe('job-1')
    expect(calls[0][1].tags.app_id).toBe('app-1')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run tests/build-ai-analyze.test.ts`
Expected: FAIL — `aiAnalyzeDeprecated`/`UPGRADE_MESSAGE` not exported.

- [ ] **Step 3: Implement** — replace the entire contents of `ai_analyze.ts` with:

```ts
// supabase/functions/_backend/public/build/ai_analyze.ts
//
// DEPRECATED ENDPOINT — permanent 426 responder.
//
// The buffered AI-analyze proxy that lived here was replaced by the streaming
// route in ./ai_analyze_stream.ts (spec: docs/superpowers/specs/
// 2026-06-05-ai-analyze-streaming-design.md). Old CLIs that still POST here
// must be told to upgrade; they print `body.error || body.message`, so the
// human-readable instruction MUST be in `error`.
import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { emitAiAnalysisResult } from './ai_analyze_telemetry.ts'

export const UPGRADE_MESSAGE = 'AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest'

export async function aiAnalyzeDeprecated(
  c: Context,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  // Best-effort tags so the dashboard can watch the old-CLI population drain.
  let jobId = ''
  let appId = ''
  try {
    const body = await c.req.raw.clone().json() as { jobId?: string, appId?: string }
    jobId = typeof body?.jobId === 'string' ? body.jobId : ''
    appId = typeof body?.appId === 'string' ? body.appId : ''
  }
  catch {
    // Unparsable body — still answer 426; tags stay empty.
  }
  await emitAiAnalysisResult(c, { appId, jobId, result: 'upgrade_required', userId: apikey.user_id, logsBytes: 0 })
  return c.json({ error: UPGRADE_MESSAGE, code: 'upgrade_required' }, 426)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run tests/build-ai-analyze.test.ts tests/build-ai-analyze-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_backend/public/build/ai_analyze.ts tests/build-ai-analyze.test.ts
git commit -m "feat(build)!: deprecate /build/ai_analyze with permanent 426 upgrade responder"
```

### Task 7: Wire the routes

**Files:**
- Modify: `supabase/functions/_backend/public/build/index.ts:72-80`

- [ ] **Step 1: Replace the old route block and add the new one**

Replace lines 72–80 with:

```ts
// POST /build/ai_analyze - DEPRECATED (pre-streaming CLIs). Always 426 + upgrade message.
app.post('/ai_analyze', middlewareKey(['all', 'write']), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return aiAnalyzeDeprecated(c, apikey)
})

// POST /build/ai_analyze_stream - Analyze a failed build's logs with AI (SSE streaming)
app.post('/ai_analyze_stream', middlewareKey(['all', 'write']), async (c) => {
  const body = await getBodyOrQuery<{ jobId: string, appId: string, logs: string }>(c)
  if (!body.jobId || !body.appId || typeof body.logs !== 'string') {
    throw new Error('jobId, appId, and logs are required in request body')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return aiAnalyzeStreamBuild(c, body.jobId, body.appId, apikey, body.logs)
})
```

Update imports at the top of `index.ts`: replace the `aiAnalyzeBuild` import from `./ai_analyze.ts` with:

```ts
import { aiAnalyzeDeprecated } from './ai_analyze.ts'
import { aiAnalyzeStreamBuild } from './ai_analyze_stream.ts'
```

- [ ] **Step 2: Typecheck + full backend test suite**

Run: `bunx vitest run tests/build-ai-analyze.test.ts tests/build-ai-analyze-stream.test.ts` and the repo's backend typecheck (`bun run typecheck` if defined at root, else `bunx tsc --noEmit -p supabase` — match whatever `package.json` defines; check with `cat package.json | head -40`).
Expected: PASS, no type errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_backend/public/build/index.ts
git commit -m "feat(build): route ai_analyze_stream, point old ai_analyze at 426 responder"
```

---

## Phase C — capgo CLI (same worktree)

### Task 8: SSE parser

**Files:**
- Create: `cli/src/ai/sse.ts`
- Test: `cli/test/test-ai-sse-parser.mjs`
- Modify: `cli/package.json` (add `test:ai-sse-parser` script + append to the `test` chain)

- [ ] **Step 1: Write the failing test** (mirror the harness style of `cli/test/test-ai-analyze-flow.mjs`: local `test()` helper, `passed`/`failed` counters, `process.exit(1)` on failures)

```js
#!/usr/bin/env node
// cli/test/test-ai-sse-parser.mjs
import { createSseParser } from '../src/ai/sse.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`✅ ${name}`); passed++ })
    .catch((err) => { console.error(`❌ ${name}\n   ${err.message}`); failed++ })
}

await test('parses a single complete frame', () => {
  const events = []
  const feed = createSseParser(e => events.push(e))
  feed('event: chunk\ndata: {"text":"hi"}\n\n')
  if (events.length !== 1) throw new Error(`got ${events.length} events`)
  if (events[0].event !== 'chunk') throw new Error(`got event ${events[0].event}`)
  if (events[0].data !== '{"text":"hi"}') throw new Error(`got data ${events[0].data}`)
})

await test('handles frames split across feeds', () => {
  const events = []
  const feed = createSseParser(e => events.push(e))
  feed('event: chu')
  feed('nk\ndata: {"text":"split"}\n')
  feed('\nevent: done\ndata: {"durationMs":3}\n\n')
  if (events.length !== 2) throw new Error(`got ${events.length} events`)
  if (events[0].data !== '{"text":"split"}') throw new Error(`got ${events[0].data}`)
  if (events[1].event !== 'done') throw new Error(`got ${events[1].event}`)
})

await test('joins multi-line data fields with newline', () => {
  const events = []
  const feed = createSseParser(e => events.push(e))
  feed('event: chunk\ndata: line1\ndata: line2\n\n')
  if (events[0].data !== 'line1\nline2') throw new Error(`got ${events[0].data}`)
})

await test('ignores comment lines and frames without data', () => {
  const events = []
  const feed = createSseParser(e => events.push(e))
  feed(': keep-alive\n\nevent: chunk\ndata: {"text":"x"}\n\n')
  if (events.length !== 1) throw new Error(`got ${events.length} events`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cli && bun test/test-ai-sse-parser.mjs`
Expected: FAIL — cannot resolve `../src/ai/sse.ts`

- [ ] **Step 3: Implement**

```ts
// cli/src/ai/sse.ts
export interface SseEvent {
  event: string
  data: string
}

// Incremental SSE frame parser. Feed it decoded text as it arrives; it fires
// onEvent once per complete frame (frames are separated by a blank line).
// Handles frames split across network chunks and multi-line data fields.
export function createSseParser(onEvent: (e: SseEvent) => void): (text: string) => void {
  let buffer = ''
  return (text: string) => {
    buffer += text
    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:'))
          event = line.slice(6).trim()
        else if (line.startsWith('data:'))
          data.push(line.slice(5).trim())
      }
      if (data.length > 0)
        onEvent({ event, data: data.join('\n') })
      sep = buffer.indexOf('\n\n')
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cli && bun test/test-ai-sse-parser.mjs`
Expected: `4 passed, 0 failed`

- [ ] **Step 5: Register the test** — in `cli/package.json` add to scripts:
`"test:ai-sse-parser": "bun test/test-ai-sse-parser.mjs"` and append `&& bun run test:ai-sse-parser` to the main `test` script chain (right after `test:ai-analyze-flow`).

- [ ] **Step 6: Commit**

```bash
git add cli/src/ai/sse.ts cli/test/test-ai-sse-parser.mjs cli/package.json
git commit -m "feat(cli): incremental SSE frame parser for AI analysis streaming"
```

### Task 9: Streaming request in the CLI

**Files:**
- Modify: `cli/src/ai/analyze.ts` (replace `postAnalyzeRequest` with `postAnalyzeStreamRequest`; update `runCapgoAiAnalysis`)
- Modify: `cli/src/ai/telemetry.ts` (extend CLI result enum with `mid_stream_error` and `upgrade_required` — find the union type of the `result` tag and add both members)
- Test: `cli/test/test-ai-analyze-stream.mjs` (new)
- Modify: `cli/test/test-ai-analyze-flow.mjs` and `cli/test/test-ai-onboarding-mode.mjs` (they import `postAnalyzeRequest` — switch those assertions to `postAnalyzeStreamRequest`; the mocked-fetch tests must now return SSE bodies)
- Modify: `cli/package.json` (register `test:ai-analyze-stream`)

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
// cli/test/test-ai-analyze-stream.mjs
import { postAnalyzeStreamRequest } from '../src/ai/analyze.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`✅ ${name}`); passed++ })
    .catch((err) => { console.error(`❌ ${name}\n   ${err.message}`); failed++ })
}

const baseInput = { apiHost: 'https://api.test', apikey: 'k', jobId: 'j1', appId: 'a1', logs: 'log text' }

function sseResponse(frames, status = 200) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

await test('accumulates chunks and resolves ok on done; onChunk fires per delta', async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/build/ai_analyze_stream')) throw new Error(`wrong url ${url}`)
    if (init.headers.accept !== 'text/event-stream') throw new Error('missing accept header')
    return sseResponse([
      'event: chunk\ndata: {"text":"Hello "}\n\n',
      'event: chunk\ndata: {"text":"world"}\n\n',
      'event: done\ndata: {"durationMs":42}\n\n',
    ])
  }
  const chunks = []
  const r = await postAnalyzeStreamRequest({ ...baseInput, onChunk: t => chunks.push(t) })
  if (r.kind !== 'ok') throw new Error(`got ${r.kind}: ${r.message}`)
  if (r.analysis !== 'Hello world') throw new Error(`got ${r.analysis}`)
  if (chunks.join('|') !== 'Hello |world') throw new Error(`got chunks ${chunks.join('|')}`)
})

await test('mid-stream error event returns kind error with partial text', async () => {
  globalThis.fetch = async () => sseResponse([
    'event: chunk\ndata: {"text":"partial diag"}\n\n',
    'event: error\ndata: {"code":"idle_timeout"}\n\n',
  ])
  const r = await postAnalyzeStreamRequest(baseInput)
  if (r.kind !== 'error') throw new Error(`got ${r.kind}`)
  if (r.message !== 'idle_timeout') throw new Error(`got ${r.message}`)
  if (r.partial !== 'partial diag') throw new Error(`got partial ${r.partial}`)
})

await test('maps 409 to already_analyzed', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'already_analyzed' }), { status: 409 })
  const r = await postAnalyzeStreamRequest(baseInput)
  if (r.kind !== 'already_analyzed') throw new Error(`got ${r.kind}`)
})

await test('maps 413 to too_big', async () => {
  globalThis.fetch = async () => new Response('', { status: 413 })
  const r = await postAnalyzeStreamRequest(baseInput)
  if (r.kind !== 'too_big') throw new Error(`got ${r.kind}`)
})

await test('maps 426 to upgrade_required with the server message', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Please upgrade', code: 'upgrade_required' }), { status: 426 })
  const r = await postAnalyzeStreamRequest(baseInput)
  if (r.kind !== 'upgrade_required') throw new Error(`got ${r.kind}`)
  if (r.message !== 'Please upgrade') throw new Error(`got ${r.message}`)
})

await test('stream ending without a terminal event is an error with partial', async () => {
  globalThis.fetch = async () => sseResponse(['event: chunk\ndata: {"text":"cut"}\n\n'])
  const r = await postAnalyzeStreamRequest(baseInput)
  if (r.kind !== 'error') throw new Error(`got ${r.kind}`)
  if (r.partial !== 'cut') throw new Error(`got partial ${r.partial}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cli && bun test/test-ai-analyze-stream.mjs`
Expected: FAIL — `postAnalyzeStreamRequest` not exported.

- [ ] **Step 3: Implement** — in `cli/src/ai/analyze.ts`:

(a) add import: `import { createSseParser } from './sse'`

(b) **delete** `postAnalyzeRequest` and its `PostAnalyzeResult` type; add:

```ts
// Watchdog values deliberately LARGER than the edge fn's (90s/30s) so the
// server layer always times out first and can send an in-band error event.
export const STREAM_FIRST_BYTE_TIMEOUT_MS = 120_000
export const STREAM_IDLE_TIMEOUT_MS = 45_000
export const STREAM_TOTAL_TIMEOUT_MS = 600_000

export type PostAnalyzeResult
  = | { kind: 'ok', analysis: string }
    | { kind: 'already_analyzed' }
    | { kind: 'too_big' }
    | { kind: 'upgrade_required', message?: string }
    | { kind: 'error', status?: number, message?: string, partial?: string }

export interface PostAnalyzeStreamInput extends PostAnalyzeInput {
  // Fired once per text delta as it arrives — used for progressive TTY rendering.
  onChunk?: (text: string) => void
}

export async function postAnalyzeStreamRequest(input: PostAnalyzeStreamInput): Promise<PostAnalyzeResult> {
  const url = `${input.apiHost}/build/ai_analyze_stream`
  const controller = new AbortController()
  let idleTimer = setTimeout(() => controller.abort(), STREAM_FIRST_BYTE_TIMEOUT_MS)
  const totalTimer = setTimeout(() => controller.abort(), STREAM_TOTAL_TIMEOUT_MS)
  let partial = ''
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'capgkey': input.apikey,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify({ jobId: input.jobId, appId: input.appId, logs: input.logs }),
      signal: controller.signal,
    })
    if (res.status === 409)
      return { kind: 'already_analyzed' }
    if (res.status === 413)
      return { kind: 'too_big' }
    if (res.status === 426) {
      const body = await res.json().catch(() => ({})) as { error?: string, message?: string }
      return { kind: 'upgrade_required', message: body.error || body.message }
    }
    if (res.status !== 200) {
      let message: string | undefined
      try {
        const body = await res.json() as { error?: string, message?: string }
        message = body.error || body.message
      }
      catch {
        // ignore
      }
      return { kind: 'error', status: res.status, message }
    }
    if (!res.body)
      return { kind: 'error', status: 200, message: 'no_body' }

    let terminal: PostAnalyzeResult | undefined
    const feed = createSseParser((e) => {
      if (e.event === 'chunk') {
        try {
          const text = (JSON.parse(e.data) as { text?: string }).text
          if (typeof text === 'string') {
            partial += text
            input.onChunk?.(text)
          }
        }
        catch {
          // malformed chunk frame — skip
        }
      }
      else if (e.event === 'done') {
        terminal = { kind: 'ok', analysis: partial }
      }
      else if (e.event === 'error') {
        let code = 'ai_error'
        try {
          code = (JSON.parse(e.data) as { code?: string }).code ?? code
        }
        catch {
          // keep default
        }
        terminal = { kind: 'error', message: code, partial }
      }
    })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)
      feed(decoder.decode(value, { stream: true }))
    }
    return terminal ?? { kind: 'error', message: 'stream_ended_without_done', partial }
  }
  catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err), partial: partial || undefined }
  }
  finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
}
```

(c) update `runCapgoAiAnalysis` (the caller-handled/onboarding entry): change its body's final call from `postAnalyzeRequest({...})` to `postAnalyzeStreamRequest({...})` — same arguments, no `onChunk` (the Ink TUI shows the result after completion). Its return type reference changes from the old union to the new `PostAnalyzeResult` automatically.

(d) in `cli/src/ai/telemetry.ts`: locate the `result` union for the `CLI AI Build Analysis Result` event and extend it with `'mid_stream_error' | 'upgrade_required'`.

- [ ] **Step 4: Fix the two existing test files** — `cli/test/test-ai-analyze-flow.mjs` and `cli/test/test-ai-onboarding-mode.mjs` import `postAnalyzeRequest`. Update the import to `postAnalyzeStreamRequest` and change each mocked `globalThis.fetch` that returned `{ analysis: '...' }` JSON to return an SSE body instead (reuse the `sseResponse` helper shape from Step 1; a 200 with frames `event: chunk\ndata: {"text":"<same text>"}\n\n` + `event: done\ndata: {"durationMs":1}\n\n`). Error-path tests (409/413/500 JSON) keep working unchanged since the status mapping is identical.

- [ ] **Step 5: Run all CLI AI tests**

Run: `cd cli && bun test/test-ai-analyze-stream.mjs && bun test/test-ai-analyze-flow.mjs && bun test/test-ai-onboarding-mode.mjs && bun test/test-ai-sse-parser.mjs`
Expected: all pass.

- [ ] **Step 6: Register and commit**

Add `"test:ai-analyze-stream": "bun test/test-ai-analyze-stream.mjs"` to `cli/package.json` scripts and append `&& bun run test:ai-analyze-stream` to the `test` chain.

```bash
git add cli/src/ai/analyze.ts cli/src/ai/telemetry.ts cli/test/ cli/package.json
git commit -m "feat(cli)!: stream AI analysis from /build/ai_analyze_stream"
```

### Task 10: Streaming UX in the build-failure flow

**Files:**
- Modify: `cli/src/build/request.ts` (the `runCapgoAi` closure, currently lines 2032–2105, and `mapPostAnalyzeResultKind`)

- [ ] **Step 1: Update `runCapgoAi`** — replace the `postAnalyzeRequest` call and result rendering (lines 2067–2104) with:

```ts
          let printedHeader = false
          const onChunk = isInteractive
            ? (text: string) => {
                if (!printedHeader) {
                  aiSpinner?.stop('Capgo AI streaming')
                  stream.write('\n--- AI analysis ---\n')
                  printedHeader = true
                }
                stream.write(text)
              }
            : undefined

          let result: PostAnalyzeResult
          try {
            result = await postAnalyzeStreamRequest({
              apiHost: host,
              apikey: options.apikey,
              jobId: capturedJobId!,
              appId,
              logs,
              onChunk,
            })
          }
          finally {
            if (!printedHeader)
              aiSpinner?.stop('Capgo AI finished')
          }

          // Telemetry — closed-enum result only, never the analysis text.
          const resultTag = mapPostAnalyzeResultKind(result.kind)
          await trackAiAnalysisResult({
            apikey: options.apikey,
            orgId,
            appId,
            platform,
            jobId: capturedJobId!,
            result: resultTag,
            errorStatus: result.kind === 'error' ? result.status : undefined,
          })

          if (result.kind === 'ok') {
            if (printedHeader) {
              // TTY already rendered the text progressively — just close out.
              stream.write(`\n\n${AI_WARNING}\n`)
            }
            else {
              // CI: buffered output, identical format to the pre-streaming CLI.
              stream.write(`\n--- AI analysis ---\n${renderMarkdown(result.analysis, isInteractive)}\n\n${AI_WARNING}\n`)
            }
          }
          else if (result.kind === 'already_analyzed') {
            stream.write('\nAI analysis already requested for this job (only one per job).\n')
          }
          else if (result.kind === 'too_big') {
            stream.write('\nLog too big for AI analysis.\n')
          }
          else if (result.kind === 'upgrade_required') {
            stream.write(`\n${result.message ?? 'AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest'}\n`)
          }
          else {
            if (result.partial && !printedHeader)
              stream.write(`\n--- AI analysis (partial) ---\n${result.partial}\n`)
            stream.write(`\nAI analysis was interrupted${result.message ? ` (${result.message})` : ''}; this job's analysis slot is used. The full log is saved at ${logsPath} for local AI.\n`)
          }
```

Update the imports in `request.ts` from `../ai/analyze`: `postAnalyzeRequest` → `postAnalyzeStreamRequest` (the `PostAnalyzeResult` type import name is unchanged).

- [ ] **Step 2: Update `mapPostAnalyzeResultKind`** — find it in `request.ts` (search `mapPostAnalyzeResultKind`) and extend the mapping: `'upgrade_required'` → `'upgrade_required'`, and `'error'` results that carry `partial` text should map to `'mid_stream_error'`. Since the helper only receives `kind`, change its signature to take the whole result:

```ts
function mapPostAnalyzeResultKind(result: PostAnalyzeResult): 'success' | 'already_analyzed' | 'too_big' | 'error' | 'mid_stream_error' | 'upgrade_required' {
  if (result.kind === 'ok')
    return 'success'
  if (result.kind === 'already_analyzed')
    return 'already_analyzed'
  if (result.kind === 'too_big')
    return 'too_big'
  if (result.kind === 'upgrade_required')
    return 'upgrade_required'
  return result.partial !== undefined ? 'mid_stream_error' : 'error'
}
```

and update its call site to `mapPostAnalyzeResultKind(result)`. Align the literal-union return type with whatever `trackAiAnalysisResult` accepts after the Task 9(d) telemetry change.

- [ ] **Step 3: Typecheck + lint + run the build-flow tests**

Run: `cd cli && bun run typecheck && bun run lint && bun test/test-ai-analyze-flow.mjs && bun test/test-build-platform-selection.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add cli/src/build/request.ts
git commit -m "feat(cli): progressive TTY streaming + CI buffering for AI build analysis"
```

---

## Phase D — rollout & verification

### Task 11: Staged deploy + live verification

**Files:** none (operational)

- [ ] **Step 1:** Merge + deploy `capgo_builder` PR (Task 3). Verify zero behavior change: trigger one failed build on the **old** capgo deployment — analysis still arrives buffered.
- [ ] **Step 2:** Open the capgo PR (Phases B+C are one PR on this branch; `git push -u origin worktree-ai-analyze-streaming-spec` and `gh pr create`). Merge + deploy the backend. From this moment old CLIs get the 426 upgrade message — confirm by curling the old route:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$CAPGO_API_HOST/build/ai_analyze" -H "capgkey: $TEST_KEY" -H 'content-type: application/json' -d '{}'
```

Expected: `426`.
- [ ] **Step 3:** Release the CLI (repo's normal release flow — `publish_cli.yml`). CI workflows use `bunx @capgo/cli@latest` and pick it up automatically.
- [ ] **Step 4:** E2E: push a commit that breaks the mobile build on `Cap-go/capgo`, let `build_mobile_android.yml` fail, and confirm the workflow log shows a complete `--- AI analysis ---` block (no `aborted due to timeout`). Check the `AI Build Analysis Result` telemetry shows `success` with `duration_ms` possibly > 60000 — the old ceiling.
- [ ] **Step 5:** Watch `result: upgrade_required` telemetry for ~1 week. When it flatlines, file the Task 12 cleanup.

### Task 12: Builder buffered-path cleanup (deferred — after cutover confirmation)

**Files:**
- Modify: `~/Developer/capgo_builder_new/src/ai-analyze.ts` (delete the non-stream branch and `extractAnalysis`/`extractContentText`/`recordOf`; reject requests without `Accept: text/event-stream` with `jsonResponse({ error: 'invalid_json', aiStarted: false }, { status: 400 })`)
- Modify: `~/Developer/capgo_builder_new/test/ai-analyze-handler.test.ts` (drop buffered-path tests; keep streaming + marker tests; the synthetic-fallback test stays — that path remains for models that ignore `stream: true`)

- [ ] **Step 1:** Only start once Task 11 Step 5 confirms zero old-protocol traffic. Make the edits above, run `bun run typecheck && bun run test`, commit as `refactor(ai-analyze)!: remove buffered JSON path after streaming cutover`, PR, deploy.

---

## Self-review notes (already applied)

- Claim ordering, refund matrix, and fail-closed defaults match spec §4 exactly; config check moved before the claim so a missing env var can't consume a slot (spec table says config_error consumes nothing).
- The builder-emitted in-band `event: error` (e.g. empty AI stream) passes through the edge fn as clean bytes — edge telemetry records `success` in that rare case while the builder logs `ai_error`; accepted granularity tradeoff, noted here intentionally.
- `PostAnalyzeResult` keeps its exported name in the CLI so `request.ts`/onboarding type imports stay stable; the old buffered `postAnalyzeRequest` is deleted with both test callers updated in the same task (Task 9).
- Builder 401 (`requireApiKey`) carries no `aiStarted` marker → edge fn fails closed; deliberate (auth/config bug should page us via `builder_error` telemetry, not silently refund).
