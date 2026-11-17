import { beforeEach, describe, expect, it, vi } from 'vitest'

// The repair of a bundle whose size was unknown records its storage event when the upload
// completed: the stored object's Last-Modified, read by the same HEAD that returns its size.

const statObject = vi.hoisted(() => vi.fn())

vi.mock('@bradenmacdonald/s3-lite-client', () => ({
  S3Client: class {
    statObject = statObject
  },
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => error,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => key === 'S3_ENDPOINT' ? 'storage.example.com' : 'test',
}))

const { s3 } = await import('../supabase/functions/_backend/utils/s3.ts')

const context = { get: vi.fn(() => undefined), req: { header: vi.fn(() => undefined), url: 'http://localhost/' } } as any

describe('s3.getSizeAndUploadedAt', () => {
  beforeEach(() => {
    statObject.mockReset()
  })

  it('returns the object size and when it was written', async () => {
    statObject.mockResolvedValue({ size: 2048, lastModified: new Date('2026-01-02T03:04:05Z') })
    await expect(s3.getSizeAndUploadedAt(context, 'orgs/o/apps/a/1.0.0.zip')).resolves.toEqual({
      size: 2048,
      uploadedAt: '2026-01-02T03:04:05.000Z',
    })
  })

  it('leaves the upload time unknown when storage does not return it', async () => {
    statObject.mockResolvedValue({ size: 2048, lastModified: new Date(Number.NaN) })
    await expect(s3.getSizeAndUploadedAt(context, 'orgs/o/apps/a/1.0.0.zip')).resolves.toEqual({
      size: 2048,
      uploadedAt: null,
    })
  })
})
