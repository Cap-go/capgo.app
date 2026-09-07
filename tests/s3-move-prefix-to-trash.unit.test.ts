import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const R2_TRASH_PREFIX = 'deleted-after-7-days/'

const mocks = vi.hoisted(() => {
  const copyObject = vi.fn(async () => {})
  const deleteObject = vi.fn(async () => {})
  const listObjects = vi.fn<() => AsyncGenerator<{ key: string }>>()

  class S3Client {
    copyObject = copyObject
    deleteObject = deleteObject
    listObjects = listObjects
    getPresignedUrl = vi.fn(async () => 'https://storage.example/presigned')
  }

  return { copyObject, deleteObject, listObjects, S3Client }
})

vi.mock('@bradenmacdonald/s3-lite-client', () => ({
  S3Client: mocks.S3Client,
}))

const { copyObject, deleteObject, listObjects } = mocks

const { s3 } = await import('../supabase/functions/_backend/utils/s3.ts')

async function makeContext() {
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
  })

  return ctx
}

function mockHeadStatus(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status,
    headers: new Headers(),
    body: { cancel: vi.fn(async () => {}) },
  })))
}

describe('moveObjectsWithPrefixToTrash', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('moves listed objects into deleted-after-7-days and deletes the source keys', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const liveKey = `${prefix}1.0.0.zip`
    const trashedKey = `${R2_TRASH_PREFIX}${liveKey}`

    listObjects.mockImplementation(async function* () {
      yield { key: liveKey }
    })
    mockHeadStatus(200)

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).toHaveBeenCalledWith({ sourceKey: liveKey }, trashedKey)
    expect(deleteObject).toHaveBeenCalledWith(liveKey)
    expect(copyObject).toHaveBeenCalledTimes(1)
    expect(deleteObject).toHaveBeenCalledTimes(1)
  })

  it('skips keys already under deleted-after-7-days', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const alreadyTrashedKey = `${R2_TRASH_PREFIX}${prefix}old.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: alreadyTrashedKey }
      yield { key: `${prefix}live.zip` }
    })
    mockHeadStatus(200)

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).toHaveBeenCalledTimes(1)
    expect(copyObject).toHaveBeenCalledWith(
      { sourceKey: `${prefix}live.zip` },
      `${R2_TRASH_PREFIX}${prefix}live.zip`,
    )
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(deleteObject).toHaveBeenCalledWith(`${prefix}live.zip`)
  })

  it('treats missing objects as success without permanent delete', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const missingKey = `${prefix}missing.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: missingKey }
    })
    mockHeadStatus(404)

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('logs per-item failures and continues without permanent delete', async () => {
    const prefix = 'orgs/org-1/apps/com.test.app/'
    const failingKey = `${prefix}fail.zip`
    const successKey = `${prefix}ok.zip`

    listObjects.mockImplementation(async function* () {
      yield { key: failingKey }
      yield { key: successKey }
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 500,
        headers: new Headers(),
        body: { cancel: vi.fn(async () => {}) },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        body: { cancel: vi.fn(async () => {}) },
      })
    vi.stubGlobal('fetch', fetchMock)

    const c = await makeContext()
    const movedCount = await s3.moveObjectsWithPrefixToTrash(c, prefix)

    expect(movedCount).toBe(1)
    expect(copyObject).toHaveBeenCalledTimes(1)
    expect(copyObject).toHaveBeenCalledWith(
      { sourceKey: successKey },
      `${R2_TRASH_PREFIX}${successKey}`,
    )
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(deleteObject).toHaveBeenCalledWith(successKey)
  })
})
