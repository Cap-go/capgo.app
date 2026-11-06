import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamBuildLogs } from '../supabase/functions/_backend/public/build/logs.ts'

const { mockRlsQuery, mockCheckPermission, mockGetEnv } = vi.hoisted(() => ({
  mockRlsQuery: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockGetEnv: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mockRlsQuery }),
  }
})

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: mockCheckPermission,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
}))

describe('build log disconnect authorization', () => {
  const requestId = 'req-build-logs-disconnect-auth'
  const jobId = 'job-build-logs-123'
  const appId = 'com.test.build.logs.disconnect'
  const builderUrl = 'https://builder.capgo.test'
  const builderApiKey = 'builder-api-key'

  function createContext() {
    const controller = new AbortController()
    const request = new Request(`http://localhost/build/logs/${jobId}?app_id=${appId}`, {
      method: 'GET',
      signal: controller.signal,
    })

    return {
      controller,
      context: {
        req: {
          raw: request,
        },
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'requestId')
            return requestId
          return undefined
        }),
      },
    }
  }

  beforeEach(() => {
    mockRlsQuery.mockReset()
    mockCheckPermission.mockReset()
    mockGetEnv.mockReset()

    mockRlsQuery.mockImplementation(async (text: string) => {
      expect(text).toContain('FROM public.build_requests')
      return { rows: [{ row: { app_id: appId } }] }
    })

    mockGetEnv.mockImplementation((_, key: string) => {
      if (key === 'BUILDER_URL')
        return builderUrl
      if (key === 'BUILDER_API_KEY')
        return builderApiKey
      return ''
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not cancel the build when a read-only caller disconnects', async () => {
    mockCheckPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === `${builderUrl}/jobs/${jobId}/logs`) {
        return new Response('data: log line\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    try {
      const { context, controller } = createContext()
      const response = await streamBuildLogs(
        context as any,
        jobId,
        appId,
        {
          key: 'read-key',
          user_id: 'user-read-only',
        } as any,
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      controller.abort()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mockCheckPermission).toHaveBeenNthCalledWith(1, context, 'app.read_logs', { appId })
      expect(mockCheckPermission).toHaveBeenNthCalledWith(2, context, 'app.build_native', { appId })
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('cancels the build on disconnect when the caller can build natively', async () => {
    let resolveCancelObserved: () => void = () => {
      throw new Error('Cancel observer not initialized')
    }
    const cancelObserved = new Promise<void>((resolve) => {
      resolveCancelObserved = resolve
    })

    mockCheckPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === `${builderUrl}/jobs/${jobId}/logs`) {
        return new Response('data: log line\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
          },
        })
      }

      if (url === `${builderUrl}/jobs/${jobId}/cancel`) {
        resolveCancelObserved()
        expect(init).toMatchObject({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': builderApiKey,
          },
          body: JSON.stringify({ app_id: appId, reason: 'client_disconnected' }),
        })

        return new Response(JSON.stringify({ status: 'cancelled' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    try {
      const { context, controller } = createContext()
      const response = await streamBuildLogs(
        context as any,
        jobId,
        appId,
        {
          key: 'all-key',
          user_id: 'user-build-native',
        } as any,
      )

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      controller.abort()
      await cancelObserved

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenNthCalledWith(2, `${builderUrl}/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': builderApiKey,
        },
        body: JSON.stringify({ app_id: appId, reason: 'client_disconnected' }),
      })
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('cancels immediately when an authorized request already aborted before listener registration', async () => {
    let resolveBuildPermission: (value: boolean) => void = () => {
      throw new Error('Build permission resolver not initialized')
    }
    let resolveCancelObserved: () => void = () => {
      throw new Error('Cancel observer not initialized')
    }
    const buildPermissionPromise = new Promise<boolean>((resolve) => {
      resolveBuildPermission = resolve
    })
    const cancelObserved = new Promise<void>((resolve) => {
      resolveCancelObserved = resolve
    })

    mockCheckPermission
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => buildPermissionPromise)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === `${builderUrl}/jobs/${jobId}/logs`) {
        return new Response('data: log line\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
          },
        })
      }

      if (url === `${builderUrl}/jobs/${jobId}/cancel`) {
        resolveCancelObserved()
        expect(init).toMatchObject({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': builderApiKey,
          },
          body: JSON.stringify({ app_id: appId, reason: 'client_disconnected' }),
        })

        return new Response(JSON.stringify({ status: 'cancelled' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    try {
      const { context, controller } = createContext()
      const responsePromise = streamBuildLogs(
        context as any,
        jobId,
        appId,
        {
          key: 'all-key',
          user_id: 'user-build-native',
        } as any,
      )

      await Promise.resolve()
      controller.abort()
      resolveBuildPermission(true)

      const response = await responsePromise
      expect(response.status).toBe(200)

      await cancelObserved

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenNthCalledWith(2, `${builderUrl}/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': builderApiKey,
        },
        body: JSON.stringify({ app_id: appId, reason: 'client_disconnected' }),
      })
    }
    finally {
      fetchMock.mockRestore()
    }
  })
})
