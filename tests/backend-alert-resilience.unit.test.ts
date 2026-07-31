import { describe, expect, it, vi } from 'vitest'
import { X_UPLOAD_HANDLER_RETRYABLE } from '../supabase/functions/_backend/files/util.ts'
import { existInEnv, getEnv } from '../supabase/functions/_backend/utils/utils.ts'

function createTestContext() {
  return {
    get(key: string) {
      if (key === 'requestId')
        return 'req-test'
      if (key === 'fileId')
        return 'orgs/test-org/apps/test-app/test.zip'
      return undefined
    },
  } as any
}

describe('backend alert resilience helpers', () => {
  it('clears stale thrown errors after a later retry succeeds', async () => {
    const { retryWithBackoff } = await import('../supabase/functions/_backend/utils/retry.ts')

    let attempts = 0
    const outcome = await retryWithBackoff(async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error('temporary queue failure')
      }

      return { ok: true }
    }, {
      attempts: 3,
      baseDelayMs: 1,
    })

    expect(attempts).toBe(2)
    expect(outcome.result).toEqual({ ok: true })
    expect(outcome.lastError).toBeUndefined()
    expect(outcome.attempts).toBe(2)
  })

  it('retries retryable durable object resets for replayable upload requests', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const handler = {
      fetch: vi.fn(),
    } as any

    let attempts = 0
    handler.fetch.mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(
          new Error('cannot access storage because object has moved to a different machine'),
          {
            retryable: true,
            durableObjectReset: true,
          },
        )
      }

      return new Response(null, { status: 204 })
    })

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'HEAD',
      }),
    )

    expect(response.status).toBe(204)
    expect(handler.fetch).toHaveBeenCalledTimes(2)
  })

  it.concurrent('retries retryable durable object responses for empty-body upload creation requests', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const handler = {
      fetch: vi.fn(),
    } as any

    handler.fetch
      .mockImplementationOnce(async (request: Request) => {
        expect(request.body).toBeNull()
        return new Response(JSON.stringify({
          error: 'durable_object_temporarily_unavailable',
        }), {
          status: 503,
          headers: {
            [X_UPLOAD_HANDLER_RETRYABLE]: '1',
          },
        })
      })
      .mockImplementationOnce(async (request: Request) => {
        expect(request.body).toBeNull()
        return new Response(null, { status: 201 })
      })

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'POST',
        headers: {
          'Content-Length': '0',
          'Tus-Resumable': '1.0.0',
        },
      }),
    )

    expect(response.status).toBe(201)
    expect(handler.fetch).toHaveBeenCalledTimes(2)
  })

  it.concurrent('returns retryable response after exhausting replayable network upload creation failures', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const handler = {
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('Network connection lost.'), {
          retryable: true,
        })
      }),
    } as any

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'POST',
        headers: {
          'Content-Length': '0',
          'Tus-Resumable': '1.0.0',
          'Upload-Length': '2500',
        },
      }),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(response.headers.get('Tus-Resumable')).toBe('1.0.0')
    await expect(response.json()).resolves.toEqual({
      error: 'upload_retryable',
      message: 'Upload temporarily unavailable. Retry the upload request.',
    })
    expect(handler.fetch).toHaveBeenCalledTimes(3)
  })

  it.concurrent('forwards a replayable zero-byte TUS creation-with-upload body', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const forwardedBodyLengths: number[] = []
    const handler = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.body).not.toBeNull()
        forwardedBodyLengths.push((await request.arrayBuffer()).byteLength)

        if (forwardedBodyLengths.length === 1) {
          return new Response(JSON.stringify({
            error: 'durable_object_temporarily_unavailable',
          }), {
            status: 503,
            headers: {
              [X_UPLOAD_HANDLER_RETRYABLE]: '1',
            },
          })
        }

        return new Response(null, { status: 201 })
      }),
    } as any

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'POST',
        headers: {
          'Content-Length': '0',
          'Content-Type': 'application/offset+octet-stream',
          'Tus-Resumable': '1.0.0',
          'Upload-Length': '0',
        },
        body: new ArrayBuffer(0),
      }),
    )

    expect(response.status).toBe(201)
    expect(handler.fetch).toHaveBeenCalledTimes(2)
    expect(forwardedBodyLengths).toEqual([0, 0])
  })

  it.concurrent('forwards a replayable zero-byte TUS patch body', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const forwardedBodyLengths: number[] = []
    const handler = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.body).not.toBeNull()
        forwardedBodyLengths.push((await request.arrayBuffer()).byteLength)

        if (forwardedBodyLengths.length === 1) {
          return new Response(JSON.stringify({
            error: 'durable_object_temporarily_unavailable',
          }), {
            status: 503,
            headers: {
              [X_UPLOAD_HANDLER_RETRYABLE]: '1',
            },
          })
        }

        return new Response(null, { status: 204 })
      }),
    } as any

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'PATCH',
        headers: {
          'Content-Length': '0',
          'Content-Type': 'Application/Offset+Octet-Stream',
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': '0',
        },
        body: new ArrayBuffer(0),
      }),
    )

    expect(response.status).toBe(204)
    expect(handler.fetch).toHaveBeenCalledTimes(2)
    expect(forwardedBodyLengths).toEqual([0, 0])
  })

  it.concurrent('recovers upload offset after a retryable durable object patch response', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const handler = {
      fetch: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          error: 'durable_object_temporarily_unavailable',
        }), {
          status: 503,
          headers: {
            [X_UPLOAD_HANDLER_RETRYABLE]: '1',
          },
        }))
        .mockResolvedValueOnce(new Response(null, {
          status: 200,
          headers: {
            'Upload-Offset': '5242880',
            'Tus-Resumable': '1.0.0',
          },
        })),
    } as any

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': '0',
          'Tus-Resumable': '1.0.0',
        },
        body: 'chunk-data',
      }),
    )

    expect(response.status).toBe(409)
    expect(response.headers.get('Upload-Offset')).toBe('5242880')
    expect(handler.fetch).toHaveBeenCalledTimes(2)
  })

  it('returns retryable response for streaming upload bodies when a durable object moves', async () => {
    const { filesTestUtils } = await import('../supabase/functions/_backend/files/files.ts')

    const handler = {
      fetch: vi.fn(),
    } as any

    handler.fetch.mockImplementation(async () => {
      throw Object.assign(
        new Error('cannot access storage because object has moved to a different machine'),
        {
          retryable: true,
          durableObjectReset: true,
        },
      )
    })

    const response = await filesTestUtils.fetchUploadHandlerWithRetry(
      createTestContext(),
      handler,
      new Request('http://localhost/files/upload/attachments/test.zip', {
        method: 'PATCH',
        body: 'chunk-data',
      }),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(response.headers.get('Tus-Resumable')).toBe('1.0.0')
    await expect(response.json()).resolves.toEqual({
      error: 'upload_retryable',
      message: 'Upload temporarily unavailable. Retry the upload request.',
    })
    expect(handler.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries transient PostgREST 502 responses for cron_stat_app', async () => {
    const { cronStatAppTestUtils } = await import('../supabase/functions/_backend/triggers/cron_stat_app.ts')

    let attempts = 0
    const result = await cronStatAppTestUtils.runSupabaseResultWithRetry(
      createTestContext(),
      'test_postgrest_retry',
      async () => {
        attempts += 1

        if (attempts === 1) {
          return {
            data: null,
            error: {
              name: 'PostgrestError',
              message: 'error code: 502',
            },
          }
        }

        return {
          data: { ok: true },
          error: null,
        }
      },
    )

    expect(attempts).toBe(2)
    expect(result.data).toEqual({ ok: true })
  })

  it('retries transient PostgREST top-level 502 statuses for cron_stat_app', async () => {
    const { cronStatAppTestUtils } = await import('../supabase/functions/_backend/triggers/cron_stat_app.ts')

    let attempts = 0
    const result = await cronStatAppTestUtils.runSupabaseResultWithRetry(
      createTestContext(),
      'test_postgrest_top_level_status_retry',
      async () => {
        attempts += 1

        if (attempts === 1) {
          return {
            data: null,
            error: {
              name: 'PostgrestError',
              message: 'temporary upstream failure',
            },
            status: 502,
          }
        }

        return {
          data: { ok: true },
          error: null,
          status: 200,
        }
      },
    )

    expect(attempts).toBe(2)
    expect(result.data).toEqual({ ok: true })
  })

  it.concurrent('retries transient PostgREST statuses for on_manifest_create updates', async () => {
    const { onManifestCreateTestUtils } = await import('../supabase/functions/_backend/triggers/on_manifest_create.ts')

    let attempts = 0
    await onManifestCreateTestUtils.runManifestUpdateWithRetry(
      createTestContext(),
      async () => {
        attempts += 1

        if (attempts === 1) {
          return {
            error: {
              name: 'PostgrestError',
              message: 'error code: 502',
            },
            status: 502,
          }
        }

        return {
          error: null,
          status: 204,
        }
      },
    )

    expect(attempts).toBe(2)
  })

  it.concurrent('marks missing manifest storage size as queue-retryable unless a trusted size already exists', async () => {
    const { onManifestCreateTestUtils } = await import('../supabase/functions/_backend/triggers/on_manifest_create.ts')

    expect(onManifestCreateTestUtils.shouldRetryManifestSizeLookup(0, 0)).toBe(true)
    expect(onManifestCreateTestUtils.shouldRetryManifestSizeLookup(0, null)).toBe(true)
    expect(onManifestCreateTestUtils.shouldRetryManifestSizeLookup(0, 128)).toBe(false)
    expect(onManifestCreateTestUtils.shouldRetryManifestSizeLookup(128, 0)).toBe(false)
  })

  it.concurrent('returns empty strings when env bindings are missing from the context', () => {
    const context = {
      req: {
        header: () => undefined,
      },
    } as any

    expect(existInEnv(context, 'ENVIRONMENT')).toBe(false)
    expect(getEnv(context, 'ENVIRONMENT')).toBe('')
  })

  it('skips stale cron_stat_app jobs when the app no longer exists', async () => {
    vi.resetModules()
    vi.doMock('../supabase/functions/_backend/utils/hono.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/hono.ts')>()
      return {
        ...actual,
        middlewareAPISecret: async (_c: any, next: any) => {
          await next()
        },
      }
    })
    vi.doMock('../supabase/functions/_backend/utils/supabase.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/supabase.ts')>()
      return {
        ...actual,
        supabaseAdmin: () => ({
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: null,
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }
    })

    const { app: cronStatApp } = await import('../supabase/functions/_backend/triggers/cron_stat_app.ts')
    const response = await cronStatApp.fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          appId: 'missing-app',
          orgId: 'test-org',
        }),
      }),
      {} as any,
      { waitUntil: () => undefined } as any,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reason: 'app_not_found',
      status: 'skipped',
    })
  })

  it('passes the queue retry budget to dispatched trigger requests', async () => {
    const { http_post_helper, MAX_QUEUE_READS } = await import('../supabase/functions/_backend/triggers/queue_consumer.ts')
    const originalFetch = globalThis.fetch
    let dispatchedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      dispatchedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    })
    globalThis.fetch = fetchMock as typeof fetch

    try {
      await http_post_helper({
        env: { API_SECRET: 'testsecret' },
        get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
      } as any, 'cron_stat_app', 'cloudflare', {
        appId: 'com.example.app',
        orgId: 'org-id',
      }, 'cf-id', {
        msgId: 1271329,
        queueName: 'cron_stat_app',
        readCount: 1,
      }, 'https://api.capgo.app/triggers/cron_stat_app')
    }
    finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(dispatchedHeaders['x-capgo-queue-name']).toBe('cron_stat_app')
    expect(dispatchedHeaders['x-capgo-queue-read-count']).toBe('1')
    expect(dispatchedHeaders['x-capgo-queue-max-reads']).toBe(String(MAX_QUEUE_READS))
  })
})
