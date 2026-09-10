import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeS3LiteCopySourceKey } from '../scripts/r2_trash_utils.ts'

const R2_TRASH_PREFIX = 'deleted-after-7-days/'
const DEFAULT_ETAG = '"test-etag"'
const DEFAULT_LAST_MODIFIED = new Date('2024-01-15T10:30:00.000Z')

function stat(etag = DEFAULT_ETAG, lastModified = DEFAULT_LAST_MODIFIED) {
  return { etag, lastModified }
}

function expectDefaultTrashDestination(destination: string | undefined, liveKey: string) {
  expect(destination).toBe(`${R2_TRASH_PREFIX}${liveKey}`)
}

const mocks = vi.hoisted(() => {
  const copyObject = vi.fn<(source: { sourceKey: string }, destination: string) => Promise<void>>(async () => {})
  const deleteObject = vi.fn<(key: string) => Promise<void>>(async () => {})
  const listObjects = vi.fn<() => AsyncGenerator<{ key: string }>>()
  const statObject = vi.fn<(key: string) => Promise<{ etag: string, size?: number, lastModified?: Date }>>(async () => stat())
  const makeRequest = vi.fn<(options: { method?: string, objectName?: string, headers?: Headers }) => Promise<Response>>(async () => new Response(null, { status: 204 }))

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
    statObject.mockImplementation(async (key: string) => {
      if (key.startsWith(R2_TRASH_PREFIX))
        throw { statusCode: 404, code: 'NotFound' }
      return stat()
    })
    makeRequest.mockImplementation(async (_options) => new Response(null, { status: 204 }))
  })

  it('moves listed objects into deleted-after-7-days and deletes the source keys', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const liveKey = `${prefix}1.0.0.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: liveKey }
    })
    statObject.mockImplementation(async (key: string) => {
      if (key === liveKey)
        return stat()
      throw { statusCode: 404, code: 'NotFound' }
    })

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(2)
    const copyCall = makeRequest.mock.calls[0]![0]!
    expect(copyCall.method).toBe('PUT')
    expectDefaultTrashDestination(copyCall.objectName, liveKey)
    expect(copyCall.headers?.get('x-amz-copy-source')).toBe(`capgo/${encodeS3LiteCopySourceKey(liveKey)}`)
    expect(copyCall.headers?.get('cf-copy-destination-if-none-match')).toBe('*')
    expect(deleteObject).not.toHaveBeenCalled()
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
    const liveKey = `${prefix}live.zip`
    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(2)
    const copyCall = makeRequest.mock.calls[0]![0]!
    expectDefaultTrashDestination(copyCall.objectName, liveKey)
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
    makeRequest.mockImplementation(async (options: { method?: string }) => {
      if (options.method === 'PUT')
        throw new Error('copy failed')
      return new Response(null, { status: 204 })
    })

    const c = await makeContext()
    await expect(s3.moveObjectsWithPrefixToTrash(c, prefix)).rejects.toBeInstanceOf(TrashMoveError)

    expect(makeRequest).toHaveBeenCalledOnce()
    expect(copyObject).not.toHaveBeenCalled()
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
      if (key.startsWith(R2_TRASH_PREFIX))
        throw { statusCode: 404, code: 'NotFound' }
      return stat()
    })

    const c = await makeContext()
    await expect(s3.moveObjectsWithPrefixToTrash(c, prefix)).rejects.toBeInstanceOf(TrashMoveError)

    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(2)
    const copyCall = makeRequest.mock.calls[0]![0]!
    expectDefaultTrashDestination(copyCall.objectName, successKey)
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
    makeRequest.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { method?: string, objectName?: string }
      if (options.method === 'PUT' && options.objectName)
        trashedDestinations.add(options.objectName)
      if (options.method === 'DELETE' && options.objectName)
        deletedSources.add(options.objectName)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return new Response(null, { status: 204 })
    })

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(25)
    expect(maxInFlight).toBeLessThanOrEqual(10)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(50)
    expect(deleteObject).not.toHaveBeenCalled()
    expect(trashedDestinations.size).toBe(25)
    expect(deletedSources.size).toBe(25)
    for (const key of keys) {
      expect(deletedSources.has(key)).toBe(true)
      expect(trashedDestinations.has(`${R2_TRASH_PREFIX}${key}`)).toBe(true)
    }
  })

  it('retains source when Last-Modified changes after copy with the same etag', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const key = `${prefix}same-etag-new-time.zip`
    const etag = DEFAULT_ETAG

    listObjects.mockImplementation(async function* () {
      yield { key }
    })
    statObject.mockImplementation(async (objectKey: string) => {
      if (objectKey.startsWith(R2_TRASH_PREFIX))
        throw { statusCode: 404, code: 'NotFound' }
      if (objectKey === key) {
        const callCount = statObject.mock.calls.filter((call: [string]) => call[0] === key).length
        if (callCount <= 1)
          return stat(etag, new Date('2024-01-15T10:30:00.000Z'))
        return stat(etag, new Date('2024-01-15T10:30:01.000Z'))
      }
      throw { statusCode: 404, code: 'NotFound' }
    })

    const c = await makeContext()
    await expect(s3.moveObjectsWithPrefixToTrash(c, prefix)).rejects.toBeInstanceOf(TrashMoveError)

    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when conditional delete cannot prove safety', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const key = `${prefix}unsafe-delete.zip`

    listObjects.mockImplementation(async function* () {
      yield { key }
    })
    makeRequest.mockImplementation(async (options: { method?: string }) => {
      if (options.method === 'DELETE')
        throw { statusCode: 412, code: 'PreconditionFailed' }
      return new Response(null, { status: 204 })
    })

    const c = await makeContext()
    await expect(s3.moveObjectsWithPrefixToTrash(c, prefix)).rejects.toBeInstanceOf(TrashMoveError)

    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(deleteObject).not.toHaveBeenCalled()
  })
})

describe('moveObjectToTrash', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    copyObject.mockImplementation(async () => {})
    deleteObject.mockImplementation(async () => {})
    makeRequest.mockImplementation(async (_options) => new Response(null, { status: 204 }))
  })

  it('keeps both trash copies when the same live key is deleted twice', async () => {
    const liveKey = 'orgs/org-1/apps/com.test.app/1.0.0.zip'
    const defaultTrash = `${R2_TRASH_PREFIX}${liveKey}`
    const copyDestinations: string[] = []
    let liveStatCount = 0

    makeRequest.mockImplementation(async (options: { method?: string, objectName?: string }) => {
      if (options.method === 'PUT' && options.objectName)
        copyDestinations.push(options.objectName)
      return new Response(null, { status: 204 })
    })
    statObject.mockImplementation(async (key: string) => {
      if (key === liveKey) {
        liveStatCount += 1
        return stat(liveStatCount <= 2 ? '"etag-1"' : '"etag-2"')
      }
      if (key === defaultTrash)
        return stat('"etag-1"')
      throw { statusCode: 404, code: 'NotFound' }
    })

    const c = await makeContext()
    expect(await s3.moveObjectToTrash(c, liveKey)).toBe(true)
    expect(await s3.moveObjectToTrash(c, liveKey)).toBe(true)

    expect(copyDestinations).toHaveLength(2)
    expect(copyDestinations[0]).not.toBe(copyDestinations[1])
    expect(copyDestinations[1]).not.toBe(defaultTrash)
  })
})

describe('deleteObjectsWithPrefix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    copyObject.mockImplementation(async () => {})
    deleteObject.mockImplementation(async () => {})
    statObject.mockImplementation(async (key: string) => {
      if (key.startsWith(R2_TRASH_PREFIX))
        throw { statusCode: 404, code: 'NotFound' }
      return stat()
    })
    makeRequest.mockImplementation(async (_options) => new Response(null, { status: 204 }))
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
