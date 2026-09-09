import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeS3LiteCopySourceKey } from '../scripts/r2_trash_utils.ts'

const R2_TRASH_PREFIX = 'deleted-after-7-days/'
const DEFAULT_ETAG = '"test-etag"'

const mocks = vi.hoisted(() => {
  const copyObject = vi.fn<(source: { sourceKey: string }, destination: string) => Promise<void>>(async () => {})
  const deleteObject = vi.fn<(key: string) => Promise<void>>(async () => {})
  const listObjects = vi.fn<() => AsyncGenerator<{ key: string }>>()
  const statObject = vi.fn<(key: string) => Promise<{ etag: string, size?: number }>>(async () => ({ etag: DEFAULT_ETAG }))
  const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))

  class S3Client {
    copyObject = copyObject
    deleteObject = deleteObject
    listObjects = listObjects
    statObject = statObject
    makeRequest = makeRequest
    getPresignedUrl = vi.fn(async () => 'https://storage.example/presigned')
  }

  return { copyObject, deleteObject, listObjects, statObject, makeRequest, S3Client }
})

vi.mock('@bradenmacdonald/s3-lite-client', () => ({
  S3Client: mocks.S3Client,
}))

const { copyObject, deleteObject, listObjects, statObject, makeRequest } = mocks

const { s3, TrashMoveError } = await import('../supabase/functions/_backend/utils/s3.ts')

async function makeContext(extraEnv: Record<string, string> = {}) {
  const app = new Hono<{ Bindings: Record<string, string> }>()
  let ctx: any
  app.get('/test', (c) => {
    ctx = c
    return c.text('ok')
  })

  await app.request('/test', {}, {
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    S3_REGION: 'auto',
    S3_BUCKET: 'capgo',
    S3_ENDPOINT: 'https://storage.example',
    S3_SSL: 'true',
    ...extraEnv,
  })

  return ctx
}

describe('moveObjectsWithPrefixToTrash', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    copyObject.mockImplementation(async () => {})
    deleteObject.mockImplementation(async () => {})
    statObject.mockImplementation(async () => ({ etag: DEFAULT_ETAG }))
    makeRequest.mockImplementation(async () => new Response(null, { status: 204 }))
  })

  it('moves listed objects into deleted-after-7-days and deletes the source keys', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const liveKey = `${prefix}1.0.0.zip`
    const trashedKey = `${R2_TRASH_PREFIX}${liveKey}`

    listObjects.mockImplementation(async function* () {
      yield { key: liveKey }
    })

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).toHaveBeenCalledWith({ sourceKey: encodeS3LiteCopySourceKey(liveKey) }, trashedKey)
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
    expect(copyObject).toHaveBeenCalledTimes(1)
  })

  it('skips keys already under deleted-after-7-days', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const alreadyTrashedKey = `${R2_TRASH_PREFIX}${prefix}old.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: alreadyTrashedKey }
      yield { key: `${prefix}live.zip` }
    })

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).toHaveBeenCalledTimes(1)
    expect(copyObject).toHaveBeenCalledWith(
      { sourceKey: encodeS3LiteCopySourceKey(`${prefix}live.zip`) },
      `${R2_TRASH_PREFIX}${prefix}live.zip`,
    )
    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('treats missing objects as success without permanent delete', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const missingKey = `${prefix}missing.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: missingKey }
    })
    statObject.mockRejectedValue({ statusCode: 404, code: 'NotFound' })

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when copyObject rejects after existence check', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const key = `${prefix}copy-fail.zip`

    listObjects.mockImplementation(async function* () {
      yield { key }
    })
    copyObject.mockRejectedValue(new Error('copy failed'))

    const c = await makeContext()
    await expect(s3.moveObjectsWithPrefixToTrash(c, prefix)).rejects.toBeInstanceOf(TrashMoveError)

    expect(copyObject).toHaveBeenCalledTimes(1)
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('fails closed when moveObjectToTrash returns false', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const failingKey = `${prefix}fail.zip`
    const successKey = `${prefix}ok.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: failingKey }
      yield { key: successKey }
    })

    statObject.mockImplementation(async (key: string) => {
      if (key === failingKey)
        throw { statusCode: 500, code: 'InternalError' }
      return { etag: DEFAULT_ETAG }
    })

    const c = await makeContext()
    await expect(s3.moveObjectsWithPrefixToTrash(c, prefix)).rejects.toBeInstanceOf(TrashMoveError)

    expect(copyObject).toHaveBeenCalledTimes(1)
    expect(copyObject).toHaveBeenCalledWith(
      { sourceKey: encodeS3LiteCopySourceKey(successKey) },
      `${R2_TRASH_PREFIX}${successKey}`,
    )
    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('processes keys with bounded concurrency', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const keys = Array.from({ length: 25 }, (_, i) => `${prefix}${i}.zip`)

    listObjects.mockImplementation(async function* () {
      for (const key of keys)
        yield { key }
    })

    let inFlight = 0
    let maxInFlight = 0
    const trashedDestinations = new Set<string>()
    const deletedSources = new Set<string>()
    copyObject.mockImplementation(async (source: { sourceKey: string }, destination: string) => {
      trashedDestinations.add(destination)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
    })
    makeRequest.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { objectName?: string }
      if (options.objectName)
        deletedSources.add(options.objectName)
      return new Response(null, { status: 204 })
    })

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(25)
    expect(maxInFlight).toBeLessThanOrEqual(10)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(copyObject).toHaveBeenCalledTimes(25)
    expect(makeRequest).toHaveBeenCalledTimes(25)
    expect(deleteObject).not.toHaveBeenCalled()
    expect(trashedDestinations.size).toBe(25)
    expect(deletedSources.size).toBe(25)
    for (const key of keys) {
      expect(trashedDestinations.has(`${R2_TRASH_PREFIX}${key}`)).toBe(true)
      expect(deletedSources.has(key)).toBe(true)
      expect(copyObject).toHaveBeenCalledWith({ sourceKey: encodeS3LiteCopySourceKey(key) }, `${R2_TRASH_PREFIX}${key}`)
    }
  })
})

describe('deleteObjectsWithPrefix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    copyObject.mockImplementation(async () => {})
    deleteObject.mockImplementation(async () => {})
    statObject.mockImplementation(async () => ({ etag: DEFAULT_ETAG }))
    makeRequest.mockImplementation(async () => new Response(null, { status: 204 }))
  })

  it('is blocked unless ALLOW_PERMANENT_R2_DELETE=true', async () => {
    listObjects.mockImplementation(async function* () {
      yield { key: 'orgs/org-1/apps/com.test.app/1.0.0.zip' }
    })

    const c = await makeContext()
    await expect(s3.deleteObjectsWithPrefix(c, 'orgs/org-1/apps/com.test.app/')).rejects.toThrow(/ALLOW_PERMANENT_R2_DELETE/)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('allows permanent delete only when ALLOW_PERMANENT_R2_DELETE=true', async () => {
    const key = 'orgs/org-1/apps/com.test.app/1.0.0.zip'
    listObjects.mockImplementation(async function* () {
      yield { key }
    })

    const c = await makeContext({ ALLOW_PERMANENT_R2_DELETE: 'true' })
    const deletedCount = await s3.deleteObjectsWithPrefix(c, 'orgs/org-1/apps/com.test.app/')

    expect(deletedCount).toBe(1)
    expect(deleteObject).toHaveBeenCalledWith(key)
    expect(copyObject).not.toHaveBeenCalled()
  })
})
