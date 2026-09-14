import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlePreviewRequest } from '../supabase/functions/_backend/files/preview.ts'
import { isTransientDatabaseError, readQuickErrorOriginalCause } from '../supabase/functions/_backend/utils/pg_errors.ts'

// backgroundTask() reads the EdgeRuntime worker global; define it so the
// fire-and-forget cache writes fall back to the no-op path under Node.
Object.assign(globalThis, { EdgeRuntime: undefined })

// Mutable result for the app_versions lookup so each test can pick the DB outcome.
const state = vi.hoisted(() => ({
  bundleResult: { data: null as unknown, error: null as unknown },
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => {
  function makeBuilder(result: { data: unknown, error: unknown }) {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'ilike', 'limit'])
      builder[method] = () => builder
    builder.maybeSingle = async () => result
    builder.single = async () => result
    return builder
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'apps')
          return makeBuilder({ data: { app_id: 'com.example.app', allow_preview: true }, error: null })
        return makeBuilder(state.bundleResult)
      },
    }),
  }
})

// 42-com-0example-0app decodes to bundle preview of com.example.app version 42.
const PREVIEW_HOST = '42-com-0example-0app.preview.capgo.app'

function buildContext(): Context<MiddlewareKeyVariables> {
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === 'host' ? PREVIEW_HOST : undefined),
      path: '/.capgo/preview.json',
      url: `https://${PREVIEW_HOST}/.capgo/preview.json`,
    },
    get: (key: string) => (key === 'requestId' ? 'test-request' : undefined),
    env: {},
  } as unknown as Context<MiddlewareKeyVariables>
}

describe('preview payload route database resilience', () => {
  beforeEach(() => {
    state.bundleResult = { data: null, error: null }
  })

  it('threads a transient DB error so onError can return a retryable 503', async () => {
    const transientError = { code: '57014', message: 'canceling statement due to statement timeout' }
    state.bundleResult = { data: null, error: transientError }

    const thrown = await handlePreviewRequest(buildContext()).then(
      () => { throw new Error('expected handlePreviewRequest to throw') },
      error => error,
    )

    const originalCause = readQuickErrorOriginalCause(thrown)
    expect(originalCause).toBe(transientError)
    expect(isTransientDatabaseError(originalCause)).toBe(true)
  })

  it('keeps a genuine missing bundle as a non-transient not-found', async () => {
    state.bundleResult = { data: null, error: null }

    const thrown = await handlePreviewRequest(buildContext()).then(
      () => { throw new Error('expected handlePreviewRequest to throw') },
      error => error,
    )

    expect(thrown.status).toBe(400)
    expect(isTransientDatabaseError(readQuickErrorOriginalCause(thrown))).toBe(false)
  })
})
