import { describe, expect, it, vi } from 'vitest'

const cloudlogMock = vi.fn()

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', () => ({
  backgroundTask: vi.fn((_c: unknown, p: Promise<unknown>) => p),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/discord.ts', () => ({
  sendDiscordAlert500: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/posthog.ts', () => ({
  capturePosthogException: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
    stack: error instanceof Error ? error.stack ?? 'N/A' : 'N/A',
  }),
}))

describe('plugin_runtime onError client cancel', () => {
  it('returns 499 AbortError after request.signal aborted', async () => {
    const { onError } = await import('../supabase/functions/_backend/plugin_runtime/utils/on_error.ts')
    const controller = new AbortController()
    controller.abort()
    const response = await onError('plugin')(
      Object.assign(new Error('request aborted'), { name: 'AbortError' }),
      {
        get: (key: string) => key === 'requestId' ? 'rid' : undefined,
        json: (body: unknown, status: number) => ({ body, status }),
        req: {
          method: 'GET',
          url: 'https://example.com/updates',
          raw: new Request('https://example.com/updates', { signal: controller.signal }),
        },
      } as any,
    )
    expect(response).toEqual({
      body: {
        error: 'request_cancelled',
        message: 'Request cancelled',
        moreInfo: {},
      },
      status: 499,
    })
    expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request_cancelled' }))
  })

  it('does not return 499 for AbortError when request.signal is not aborted', async () => {
    const { onError } = await import('../supabase/functions/_backend/plugin_runtime/utils/on_error.ts')
    const response = await onError('plugin')(
      Object.assign(new Error('request aborted'), { name: 'AbortError' }),
      {
        get: (key: string) => key === 'requestId' ? 'rid' : undefined,
        json: (body: unknown, status: number) => ({ body, status }),
        req: {
          method: 'GET',
          url: 'https://example.com/updates',
          raw: new Request('https://example.com/updates'),
        },
      } as any,
    )
    expect(response.status).not.toBe(499)
  })

  it('does not return 499 for non-abort error when request.signal is aborted', async () => {
    const { onError } = await import('../supabase/functions/_backend/plugin_runtime/utils/on_error.ts')
    const controller = new AbortController()
    controller.abort()
    const response = await onError('plugin')(
      new Error('upstream failure'),
      {
        get: (key: string) => key === 'requestId' ? 'rid' : undefined,
        json: (body: unknown, status: number) => ({ body, status }),
        req: {
          method: 'GET',
          url: 'https://example.com/updates',
          raw: new Request('https://example.com/updates', { signal: controller.signal }),
        },
      } as any,
    )
    expect(response.status).not.toBe(499)
  })
})
