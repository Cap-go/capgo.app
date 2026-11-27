import { describe, expect, it, vi } from 'vitest'
import { RetryBucket } from '../supabase/functions/_backend/files/retry.ts'

const r2InternalError = () => new Error('createMultipartUpload: We encountered an internal error. Please try again. (10001)')

describe('RetryBucket.createMultipartUpload', () => {
  it('retries a transient R2 internal error', async () => {
    const r2Upload = { key: 'my-file', uploadId: 'upload-id' }
    const createMultipartUpload = vi.fn()
      .mockRejectedValueOnce(r2InternalError())
      .mockResolvedValueOnce(r2Upload)

    const upload = await new RetryBucket({ createMultipartUpload } as any, { maxRetries: 5, durationMillis: 1 })
      .createMultipartUpload('my-file', { customMetadata: { a: 'b' } })

    expect(createMultipartUpload).toHaveBeenCalledTimes(2)
    expect(createMultipartUpload).toHaveBeenLastCalledWith('my-file', { customMetadata: { a: 'b' } })
    expect(upload.r2MultipartUpload).toBe(r2Upload)
  })

  it('throws after the maximum number of retries', async () => {
    const createMultipartUpload = vi.fn().mockRejectedValue(r2InternalError())

    await expect(new RetryBucket({ createMultipartUpload } as any, { maxRetries: 2, durationMillis: 1 }).createMultipartUpload('my-file'))
      .rejects
      .toThrow('10001')
    expect(createMultipartUpload).toHaveBeenCalledTimes(3)
  })
})
