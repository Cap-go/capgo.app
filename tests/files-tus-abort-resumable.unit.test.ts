import { describe, expect, it, vi } from 'vitest'
import { TusClientDisconnectedError } from '../supabase/functions/_backend/files/util.ts'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObjectMock {},
  WorkerEntrypoint: class WorkerEntrypointMock {},
}))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'node',
  }
})

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert500: vi.fn(() => Promise.resolve()),
  sendDiscordAlert: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>()
  return {
    ...actual,
    cloudlogErr: vi.fn(),
  }
})

describe('TUS upload handler client disconnect', () => {
  it('returns resumable Upload-Offset when append aborts mid upload', async () => {
    const { BUFFER_SIZE, UPLOAD_INFO_KEY, UPLOAD_OFFSET_KEY, TUS_VERSION } = await import('../supabase/functions/_backend/files/util.ts')
    const { DEFAULT_RETRY_PARAMS, RetryBucket } = await import('../supabase/functions/_backend/files/retry.ts')
    const { UploadHandler } = await import('../supabase/functions/_backend/files/uploadHandler.ts')

    const mockBucket = {
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
      head: vi.fn(async () => null),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      put: vi.fn(async () => {}),
    }

    const storageMap = new Map<string, unknown>()
    const storage = {
      get: vi.fn(async (key: string) => storageMap.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storageMap.set(key, value)
      }),
      deleteAll: vi.fn(async () => {
        storageMap.clear()
      }),
      deleteAlarm: vi.fn(async () => {}),
      getAlarm: vi.fn(async () => Date.now() + 86_400_000),
    }

    const resumeOffset = BUFFER_SIZE + 100
    storageMap.set(UPLOAD_OFFSET_KEY, resumeOffset)
    storageMap.set(UPLOAD_INFO_KEY, {
      uploadLength: BUFFER_SIZE * 10,
      r2Key: 'orgs/test/apps/com.test.abort/bundle.zip',
    })

    const handler = new UploadHandler({ storage } as any, {
      ATTACHMENT_BUCKET: mockBucket as any,
      MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret',
    })
    ;(handler as any).ctx = { storage, waitUntil: (promise: Promise<unknown>) => promise }
    handler.retryBucket = new RetryBucket(mockBucket as any, DEFAULT_RETRY_PARAMS)

    const origAppend = handler.appendBody.bind(handler)
    handler.appendBody = async () => {
      throw new TusClientDisconnectedError()
    }

    const r2Key = 'orgs/test/apps/com.test.abort/bundle.zip'
    const patchResponse = await handler.fetch(new Request(`http://localhost/files/upload/attachments/${r2Key}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Tus-Resumable': TUS_VERSION,
        'Upload-Length': String(BUFFER_SIZE * 10),
        'Upload-Offset': String(resumeOffset),
        'X-Request-Id': 'tus-abort-patch',
      },
      body: new Uint8Array(1),
    }))

    handler.appendBody = origAppend

    expect(patchResponse.status).toBe(499)
    expect(patchResponse.headers.get('Upload-Offset')).toBe(String(resumeOffset))
  })
})
