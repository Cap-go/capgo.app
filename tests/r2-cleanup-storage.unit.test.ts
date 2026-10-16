import type { S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupWorkflow } from '../cloudflare_workers/r2_inventory/cleanup_consumer.ts'
import { cleanupStorage, createCleanupStorage } from '../cloudflare_workers/r2_inventory/cleanup_storage.ts'

const env = { S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'synthetic-access', S3_SECRET_ACCESS_KEY: 'synthetic-secret' }
const key = 'orgs/synthetic/apps/com.test.cleanup/delta/file +&'
const value = { schemaVersion: 1 as const, bucket: 'capgo', key, cleanupRequestedAt: '2026-10-14T00:00:00.123456Z' }
const success = () => new Response('<CopyObjectResult><ETag>"etag"</ETag><LastModified>2026-10-14T00:00:00Z</LastModified></CopyObjectResult>')
const error = (code: string, status: number) => new Response(`<Error><Code>${code}</Code><Message>Synthetic error</Message></Error>`, { status })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('cleanup real S3 transport', () => {
  it('copies server-side with both conditions, keeps metadata, consumes success XML, then deletes without downloading', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(success()).mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    await createCleanupStorage(env).remove('capgo', key, 'etag', new AbortController().signal)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const copy = fetcher.mock.calls[0][0] as Request
    const remove = fetcher.mock.calls[1][0] as Request
    expect(copy.method).toBe('PUT')
    expect(copy.headers.get('x-amz-copy-source-if-match')).toBe('"etag"')
    expect(copy.headers.get('cf-copy-destination-if-none-match')).toBe('*')
    expect(copy.headers.get('x-amz-metadata-directive')).toBe('COPY')
    expect(copy.headers.get('x-amz-copy-source')).toBe('capgo/orgs/synthetic/apps/com.test.cleanup/delta/file%20%2B%26')
    expect(copy.url).toContain('/capgo/deleted-after-7-days/')
    expect(remove.method).toBe('DELETE')
    expect(remove.url).not.toContain('deleted-after-7-days')
  })

  it.each([['AccessDenied', 403], ['InternalError', 500], ['InternalError', 200]])('never deletes or secretly retries %s/%s', async (code, status) => {
    const fetcher = vi.fn().mockImplementation(async () => error(code, status))
    vi.stubGlobal('fetch', fetcher)
    await expect(createCleanupStorage(env).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses a partial/malformed copy success response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<CopyObjectResult><ETag>"etag"</ETag></CopyObjectResult>'))
    vi.stubGlobal('fetch', fetcher)
    await expect(createCleanupStorage(env).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toThrow('unconfirmed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports copy response field presence without logging object or credential values', async () => {
    const report = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<CopyObjectResult><ETag>"etag"</ETag></CopyObjectResult>')))
    await expect(createCleanupStorage(env, report).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toThrow('unconfirmed')
    expect(report).toHaveBeenCalledExactlyOnceWith({
      stage: 'copy_response',
      errorType: 'Error',
      httpStatus: 200,
      hasCopyResult: true,
      hasCopyEtag: true,
      hasCopyLastModified: false,
      elapsedMs: expect.any(Number),
      operationMs: { copy: expect.any(Number) },
    })
    for (const privateValue of [key, env.S3_ENDPOINT, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY])
      expect(JSON.stringify(report.mock.calls)).not.toContain(privateValue)
  })

  it('reports a delete failure separately from a successful copy and hides unrecognized error names', async () => {
    const report = vi.fn()
    const failure = Object.assign(new Error('synthetic private detail'), { name: 'synthetic-private-name', $metadata: { httpStatusCode: 403 } })
    const send = vi.fn().mockResolvedValueOnce({ CopyObjectResult: { ETag: '"etag"', LastModified: new Date() }, $metadata: { httpStatusCode: 200 } }).mockRejectedValueOnce(failure)
    await expect(cleanupStorage({ send } as unknown as S3Client, report).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toBe(failure)
    expect(report).toHaveBeenCalledExactlyOnceWith({
      stage: 'delete',
      errorType: 'OtherError',
      httpStatus: 403,
      hasCopyResult: true,
      hasCopyEtag: true,
      hasCopyLastModified: true,
      elapsedMs: expect.any(Number),
      operationMs: { copy: expect.any(Number), delete: expect.any(Number) },
    })
  })

  it('does not reuse a copy status for a later network failure or replace the original error', async () => {
    const failure = new TypeError('synthetic private network detail')
    const report = vi.fn(() => {
      throw new Error('Synthetic diagnostic outage')
    })
    const send = vi.fn().mockResolvedValueOnce({ CopyObjectResult: { ETag: '"etag"', LastModified: new Date() }, $metadata: { httpStatusCode: 200 } }).mockRejectedValueOnce(failure)
    await expect(cleanupStorage({ send } as unknown as S3Client, report).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toBe(failure)
    expect(report).toHaveBeenCalledExactlyOnceWith({
      stage: 'delete',
      errorType: 'TypeError',
      httpStatus: undefined,
      hasCopyResult: true,
      hasCopyEtag: true,
      hasCopyLastModified: true,
      elapsedMs: expect.any(Number),
      operationMs: { copy: expect.any(Number), delete: expect.any(Number) },
    })
  })
})

describe('cleanup retry recovery and deadlines', () => {
  const client = (send: ReturnType<typeof vi.fn>) => cleanupStorage({ send } as unknown as S3Client)
  const copied = { CopyObjectResult: { ETag: '"etag"', LastModified: new Date() } }
  const missing = () => Object.assign(new Error('Missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
  const condition = () => Object.assign(new Error('Condition'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
  const head = { ETag: '"etag"', ContentLength: 42, Metadata: { synthetic: 'preserved' } }

  it('validates an existing backup without overwriting it after copy succeeded/delete failed', async () => {
    const send = vi.fn().mockResolvedValueOnce(copied).mockRejectedValueOnce(new Error('Delete failed'))
    const storage = client(send)
    await expect(storage.remove('capgo', key, 'etag', new AbortController().signal)).rejects.toThrow('Delete failed')
    send.mockRejectedValueOnce(condition()).mockResolvedValueOnce(head).mockResolvedValueOnce(head).mockResolvedValueOnce({})
    await storage.remove('capgo', key, 'etag', new AbortController().signal)
    expect(send.mock.calls.map(call => call[0].constructor.name)).toEqual([
      'CopyObjectCommand',
      'DeleteObjectCommand',
      'CopyObjectCommand',
      'HeadObjectCommand',
      'HeadObjectCommand',
      'DeleteObjectCommand',
    ])
  })

  it('treats definitive absence as idempotent success after a lost acknowledgement', async () => {
    const send = vi.fn().mockRejectedValueOnce(missing()).mockRejectedValueOnce(missing())
    await client(send).remove('capgo', key, 'etag', new AbortController().signal)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].constructor.name).toBe('HeadObjectCommand')
  })

  it('reports the original copy failure when a recovery HEAD succeeds', async () => {
    const failure = missing()
    const report = vi.fn()
    const send = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(head)
    await expect(cleanupStorage({ send } as unknown as S3Client, report).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toBe(failure)
    expect(report).toHaveBeenCalledExactlyOnceWith({
      stage: 'copy',
      errorType: 'NoSuchKey',
      httpStatus: 404,
      elapsedMs: expect.any(Number),
      operationMs: { copy: expect.any(Number), head_source: expect.any(Number) },
    })
  })

  it('separates time spent copying from time spent in a failed recovery HEAD', async () => {
    vi.useFakeTimers()
    const report = vi.fn()
    const send = vi.fn().mockImplementationOnce(async () => {
      vi.advanceTimersByTime(15000)
      throw condition()
    }).mockImplementationOnce(async () => {
      vi.advanceTimersByTime(5000)
      throw Object.assign(new Error('Synthetic abort'), { name: 'AbortError' })
    })
    await expect(cleanupStorage({ send } as unknown as S3Client, report).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toThrow('Synthetic abort')
    expect(report).toHaveBeenCalledExactlyOnceWith({
      stage: 'head_source',
      errorType: 'AbortError',
      httpStatus: undefined,
      elapsedMs: 20000,
      operationMs: { copy: 15000, head_source: 5000 },
    })
  })

  it('obtains missing inventory ETag with HEAD and fails closed on unknown absence or missing bucket', async () => {
    const send = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(copied).mockResolvedValueOnce({})
    await client(send).remove('capgo', key, null, new AbortController().signal)
    expect(send.mock.calls.map(call => call[0].constructor.name)).toEqual(['HeadObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand'])
    for (const failure of [new Error('Network timeout'), Object.assign(new Error('No bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })]) {
      const bad = vi.fn().mockRejectedValue(failure)
      await expect(client(bad).remove('capgo', key, null, new AbortController().signal)).rejects.toThrow()
      expect(bad).toHaveBeenCalledTimes(1)
    }
  })

  it.each([{ ETag: 'etag', ContentLength: 42, Metadata: { synthetic: 'changed' } }, { ETag: 'other', ContentLength: 42 }, { ETag: 'etag', ContentLength: 43 }, null])('preserves mismatched backup %j', async (backup) => {
    const send = vi.fn().mockRejectedValueOnce(condition()).mockResolvedValueOnce(head)
    if (backup)
      send.mockResolvedValueOnce(backup)
    else
      send.mockRejectedValueOnce(missing())
    await expect(client(send).remove('capgo', key, 'etag', new AbortController().signal)).rejects.toThrow('differs')
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('never starts DELETE when COPY resolves after the abandoned workflow deadline', async () => {
    vi.useFakeTimers()
    let finish: (value: unknown) => void = () => {}
    const send = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const storage = client(send)
    const work = cleanupWorkflow(storage, value, 'etag', Date.now() + 20000)
    const rejected = expect(work).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(20001)
    await rejected
    finish(copied)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1].abortSignal.aborted).toBe(true)
  })

  it('aborts a pending transport at its actual per-object deadline', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.stubGlobal('fetch', vi.fn((request: Request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('Aborted synthetic request'))
      })
    })))
    const work = cleanupWorkflow(createCleanupStorage(env), value, 'etag', Date.now() + 20000)
    const rejected = expect(work).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(20001)
    await rejected
    expect(aborted).toBe(true)
  })
})
