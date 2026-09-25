import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()
const closeClientMock = vi.fn()
const getPgClientMock = vi.fn(async () => ({ query: queryMock }))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'workerd',
  }
})

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

const originalCaches = globalThis.caches

function createContext(requestId = 'req-1') {
  return { get: (key: string) => (key === 'requestId' ? requestId : undefined) } as any
}

describe('file_read_cache deleted lookup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    queryMock.mockResolvedValue({ rows: [] })
    globalThis.caches = undefined as any
  })

  afterEach(() => {
    globalThis.caches = originalCaches
  })

  it('creates a fresh pg client per request, not a module-level pool', async () => {
    const { isAttachmentVersionDeleted } = await import('../supabase/functions/_backend/files/file_read_cache.ts')
    const fileId = 'orgs/test-org/apps/test-app/bundle.zip'
    const contextA = createContext('req-a')
    const contextB = createContext('req-b')

    await isAttachmentVersionDeleted(contextA, fileId)
    await isAttachmentVersionDeleted(contextB, fileId)

    expect(getPgClientMock).toHaveBeenCalledTimes(2)
    expect(getPgClientMock.mock.calls[0]?.[0]).toBe(contextA)
    expect(getPgClientMock.mock.calls[1]?.[0]).toBe(contextB)
  })

  it('closes the pg client after the lookup finishes', async () => {
    const { isAttachmentVersionDeleted } = await import('../supabase/functions/_backend/files/file_read_cache.ts')
    const context = createContext()
    const client = { query: queryMock }

    getPgClientMock.mockResolvedValueOnce(client)

    await isAttachmentVersionDeleted(context, 'orgs/test-org/apps/test-app/bundle.zip')

    expect(closeClientMock).toHaveBeenCalledTimes(1)
    expect(closeClientMock).toHaveBeenCalledWith(context, client)
  })

  it('runs the primary lookup at most once per request context', async () => {
    const { isAttachmentVersionDeleted } = await import('../supabase/functions/_backend/files/file_read_cache.ts')
    const context = createContext()
    const fileId = 'orgs/test-org/apps/test-app/bundle.zip'

    await Promise.all([
      isAttachmentVersionDeleted(context, fileId),
      isAttachmentVersionDeleted(context, fileId),
      isAttachmentVersionDeleted(context, fileId),
    ])

    expect(getPgClientMock).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('fails open when the lookup exceeds the timeout budget', async () => {
    vi.useFakeTimers()
    try {
      const { fileReadCacheTestUtils, isAttachmentVersionDeleted } = await import('../supabase/functions/_backend/files/file_read_cache.ts')
      const context = createContext()
      const fileId = 'orgs/test-org/apps/test-app/bundle.zip'

      queryMock.mockImplementation(() => new Promise(() => {}))

      const pending = isAttachmentVersionDeleted(context, fileId)
      await vi.advanceTimersByTimeAsync(fileReadCacheTestUtils.DELETED_LOOKUP_TIMEOUT_MS + 50)
      await expect(pending).resolves.toBe(false)

      expect(closeClientMock).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
