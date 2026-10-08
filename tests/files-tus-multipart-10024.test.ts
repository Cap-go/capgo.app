import { describe, expect, it, vi, beforeEach } from 'vitest'

const sendDiscordAlert500Mock = vi.fn(() => Promise.resolve())
const cloudlogErrMock = vi.fn()

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
  sendDiscordAlert500: sendDiscordAlert500Mock,
  sendDiscordAlert: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>()
  return {
    ...actual,
    cloudlogErr: cloudlogErrMock,
  }
})

describe('TUS upload when R2 multipart session is missing', () => {
  beforeEach(() => {
    sendDiscordAlert500Mock.mockClear()
    cloudlogErrMock.mockClear()
  })

  it('returns 409 without Discord alert and follow-up HEAD is 404', async () => {
    const multipartMissingError = new Error('uploadPart: The specified multipart upload does not exist. (10024)')
    const uploadPartMock = vi.fn().mockRejectedValue(multipartMissingError)

    const r2MultipartUpload = {
      uploadId: 'upload-id-1',
      uploadPart: uploadPartMock,
      abort: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    }

    const mockBucket = {
      createMultipartUpload: vi.fn(async () => r2MultipartUpload),
      resumeMultipartUpload: vi.fn(() => r2MultipartUpload),
      head: vi.fn(async () => null),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      put: vi.fn(async () => {}),
    }

    const { BUFFER_SIZE, UPLOAD_INFO_KEY, UPLOAD_OFFSET_KEY, TUS_VERSION } = await import('../supabase/functions/_backend/files/util.ts')
    const { DEFAULT_RETRY_PARAMS, RetryBucket } = await import('../supabase/functions/_backend/files/retry.ts')
    const { UploadHandler } = await import('../supabase/functions/_backend/files/uploadHandler.ts')

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

    storageMap.set(UPLOAD_OFFSET_KEY, 0)
    storageMap.set(UPLOAD_INFO_KEY, { uploadLength: BUFFER_SIZE * 10 })

    const handler = new UploadHandler({ storage } as any, {
      ATTACHMENT_BUCKET: mockBucket as any,
      MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret',
    })
    ;(handler as any).ctx = { storage, waitUntil: (promise: Promise<unknown>) => promise }
    handler.retryBucket = new RetryBucket(mockBucket as any, DEFAULT_RETRY_PARAMS)

    const r2Key = 'orgs/test/apps/com.test.multipart10024/bundle.zip'
    const patchResponse = await handler.fetch(new Request(`http://localhost/files/upload/attachments/${r2Key}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Tus-Resumable': TUS_VERSION,
        'Upload-Length': String(BUFFER_SIZE * 10),
        'Upload-Offset': '0',
        'X-Request-Id': 'multipart-10024-patch',
      },
      // One byte past BUFFER_SIZE forces an intermediate multipart part before the final chunk.
      body: new Uint8Array(BUFFER_SIZE + 1),
    }))

    expect(patchResponse.status).toBe(409)
    expect(uploadPartMock).toHaveBeenCalled()
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(cloudlogErrMock.mock.calls.some(call => (call[0] as { kind?: string })?.kind === 'unhandled_error')).toBe(false)

    const headResponse = await handler.fetch(new Request(`http://localhost/files/upload/attachments/${r2Key}`, {
      method: 'HEAD',
      headers: {
        'Tus-Resumable': TUS_VERSION,
        'X-Request-Id': 'multipart-10024-head',
      },
    }))

    expect(headResponse.status).toBe(404)
  })
})
