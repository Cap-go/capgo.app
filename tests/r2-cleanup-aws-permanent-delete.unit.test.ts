import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { permanentDeleteAwsLiveKey } from '../scripts/r2_cleanup/aws_permanent_delete.ts'
import {
  buildR2ConditionalDeleteHeaders,
  formatR2ConditionalDeleteLastModified,
  R2_TRASH_PREFIX,
} from '../scripts/r2_trash_utils.ts'

describe('permanentDeleteAwsLiveKey', () => {
  const bucket = 'capgo'
  const key = 'orgs/org-1/apps/com.test/file.zip'
  const etag = '"abc123"'
  const lastModified = new Date('2024-01-15T10:30:00.000Z')

  it('skips keys already under deleted-after-7-days/', async () => {
    const send = vi.fn()
    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, `${R2_TRASH_PREFIX}${key}`)
    expect(outcome).toBe('skipped_missing')
    expect(send).not.toHaveBeenCalled()
  })

  it('heads the live object then deletes with IfMatch guards', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return { ETag: etag, LastModified: lastModified }
      if (command instanceof DeleteObjectCommand)
        return {}
      throw new Error('unexpected command')
    })

    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key, etag, lastModified)

    expect(outcome).toBe('deleted')
    expect(send).toHaveBeenCalledTimes(2)
    const deleteCall = send.mock.calls.find(([cmd]) => cmd instanceof DeleteObjectCommand)?.[0] as DeleteObjectCommand
    expect(deleteCall.input.Bucket).toBe(bucket)
    expect(deleteCall.input.Key).toBe(key)
    expect(deleteCall.input.IfMatch).toBe(etag)
  })

  it('uses guarded delete headers with RFC 3339 Last-Modified and quoted If-Match', () => {
    expect(buildR2ConditionalDeleteHeaders({ etag, lastModified })).toEqual({
      'x-amz-if-match-last-modified-time': formatR2ConditionalDeleteLastModified(lastModified),
      'If-Match': etag,
    })
  })

  it('retains source when conditional delete returns precondition failed', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return { ETag: etag, LastModified: lastModified }
      if (command instanceof DeleteObjectCommand)
        throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }
      throw new Error('unexpected command')
    })

    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key, etag, lastModified)

    expect(outcome).toBe('skipped_changed')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('fails closed when discovery etag is missing', async () => {
    const send = vi.fn()
    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key)
    expect(outcome).toBe('failed')
    expect(send).not.toHaveBeenCalled()
  })

  it('fails closed when HeadObject returns no etag or lastModified', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return { ETag: undefined, LastModified: lastModified }
      throw new Error('delete should not run')
    })

    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key, '"missing-head-etag"', lastModified)

    expect(outcome).toBe('failed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('retains source when listing etag no longer matches HeadObject', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return { ETag: '"replacement"', LastModified: lastModified }
      throw new Error('delete should not run')
    })

    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key, '"listed"', lastModified)

    expect(outcome).toBe('skipped_changed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('fails closed when discovery Last-Modified is missing', async () => {
    const send = vi.fn()
    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key, etag)
    expect(outcome).toBe('failed')
    expect(send).not.toHaveBeenCalled()
  })

  it('retains source when discovery Last-Modified no longer matches HeadObject', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return { ETag: etag, LastModified: lastModified }
      throw new Error('delete should not run')
    })

    const outcome = await permanentDeleteAwsLiveKey(
      { send },
      bucket,
      key,
      etag,
      new Date('2024-01-15T10:30:01.000Z'),
    )

    expect(outcome).toBe('skipped_changed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats missing source as skipped_missing', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        throw { name: 'NotFound', $metadata: { httpStatusCode: 404 } }
      throw new Error('delete should not run')
    })

    const outcome = await permanentDeleteAwsLiveKey({ send }, bucket, key, etag, lastModified)

    expect(outcome).toBe('skipped_missing')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
