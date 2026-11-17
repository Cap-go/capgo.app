import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeObject { key: string }

const storage = vi.hoisted(() => ({
  keys: [] as string[],
  makeRequest: vi.fn(),
  deleteObject: vi.fn(),
  listCalls: [] as { prefix: string, continuationToken?: string }[],
}))

vi.mock('@bradenmacdonald/s3-lite-client', () => ({
  S3Client: class {
    async* listObjectsGrouped(options: { prefix: string, maxResults: number, continuationToken?: string }) {
      storage.listCalls.push({ prefix: options.prefix, continuationToken: options.continuationToken })
      const matching = storage.keys.filter(key => key.startsWith(options.prefix)).sort()
      const start = options.continuationToken ? matching.findIndex(key => key > options.continuationToken!) : 0
      const page = start < 0 ? [] : matching.slice(start, start + options.maxResults)
      for (const key of page)
        yield { type: 'Object', key, lastModified: new Date(0), size: 1 } as FakeObject & { type: 'Object' }
      const last = page.at(-1)
      return last && start + page.length < matching.length ? last : undefined
    }

    makeRequest(options: unknown) {
      return storage.makeRequest(options)
    }

    deleteObject(key: string) {
      return storage.deleteObject(key)
    }
  },
}))

const { DELETE_OBJECTS_MAX_KEYS, buildDeleteObjectsBody, parseDeleteObjectsErrors, s3 } = await import('../supabase/functions/_backend/utils/s3.ts')

function keysInBody(body: string) {
  return [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map(match => match[1])
}

async function runInContext<T>(fn: (c: any) => Promise<T>): Promise<T> {
  let result: T | undefined
  let failure: unknown
  const app = new Hono<{ Bindings: Record<string, string> }>()
  app.post('/', async (c) => {
    try {
      result = await fn(c)
    }
    catch (error) {
      failure = error
    }
    return c.text('ok')
  })
  await app.request('http://127.0.0.1/', { method: 'POST' }, {
    S3_ENDPOINT: 'https://storage.example.com',
    S3_BUCKET: 'capgo',
    S3_ACCESS_KEY_ID: 'id',
    S3_SECRET_ACCESS_KEY: 'secret',
  })
  if (failure)
    throw failure
  return result as T
}

function removeKeysFromStorage(keys: string[]) {
  const removed = new Set(keys)
  storage.keys = storage.keys.filter(key => !removed.has(key))
}

describe('deleteObjectsWithPrefix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.listCalls = []
    storage.makeRequest.mockImplementation(async (options: { payload: string }) => {
      removeKeysFromStorage(keysInBody(options.payload))
      return new Response('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>')
    })
    storage.deleteObject.mockImplementation(async (key: string) => removeKeysFromStorage([key]))
  })

  it('deletes with one DeleteObjects request per 1,000 keys instead of one request per object', async () => {
    const prefix = 'orgs/org-1/apps/com.example.app/'
    storage.keys = [
      ...Array.from({ length: 2_500 }, (_, i) => `${prefix}manifest/${String(i).padStart(5, '0')}`),
      'orgs/org-1/apps/com.example.other/keep.zip',
    ]

    const result = await runInContext(c => s3.deleteObjectsWithPrefix(c, prefix))

    expect(result).toEqual({ deleted: 2_500, failed: 0, done: true })
    expect(storage.deleteObject).not.toHaveBeenCalled()
    expect(storage.makeRequest).toHaveBeenCalledTimes(3)
    const batches = storage.makeRequest.mock.calls.map(([options]) => options as { method: string, query: Record<string, string>, payload: string, headers: Headers })
    expect(batches.map(batch => keysInBody(batch.payload).length)).toEqual([1_000, 1_000, 500])
    for (const batch of batches) {
      expect(batch.method).toBe('POST')
      expect(batch.query).toEqual({ delete: '' })
      expect(batch.headers.get('x-amz-checksum-sha256')).toMatch(/^[A-Za-z0-9+/]{43}=$/)
      expect(keysInBody(batch.payload).length).toBeLessThanOrEqual(DELETE_OBJECTS_MAX_KEYS)
    }
    expect(storage.keys).toEqual(['orgs/org-1/apps/com.example.other/keep.zip'])
  })

  it('stops at the deadline and reports the prefix as not done', async () => {
    const prefix = 'orgs/org-1/apps/com.example.app/'
    storage.keys = Array.from({ length: 2_500 }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`)
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    storage.makeRequest.mockImplementation(async (options: { payload: string }) => {
      removeKeysFromStorage(keysInBody(options.payload))
      now += 10_000
      return new Response('<DeleteResult/>')
    })

    try {
      const result = await runInContext(c => s3.deleteObjectsWithPrefix(c, prefix, { deadline: 15_000 }))
      expect(result).toEqual({ deleted: 2_000, failed: 0, done: false })
      expect(storage.makeRequest).toHaveBeenCalledTimes(2)
      expect(storage.keys).toHaveLength(500)
    }
    finally {
      dateNow.mockRestore()
    }
  })

  it('counts keys reported as errors as failed and keeps the prefix not done', async () => {
    const prefix = 'orgs/org-1/apps/com.example.app/'
    storage.keys = [`${prefix}a`, `${prefix}b&c`, `${prefix}gone`]
    storage.makeRequest.mockResolvedValue(new Response(`<DeleteResult>
      <Error><Key>${prefix}b&amp;c</Key><Code>AccessDenied</Code></Error>
      <Error><Key>${prefix}gone</Key><Code>NoSuchKey</Code></Error>
    </DeleteResult>`))

    const result = await runInContext(c => s3.deleteObjectsWithPrefix(c, prefix))

    expect(result).toEqual({ deleted: 2, failed: 1, done: false })
  })

  it('falls back to bounded single deletes when the server rejects DeleteObjects', async () => {
    const prefix = 'orgs/org-1/apps/com.example.app/'
    storage.keys = Array.from({ length: 40 }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)
    storage.makeRequest.mockRejectedValue(Object.assign(new Error('not implemented'), { statusCode: 501 }))

    const result = await runInContext(c => s3.deleteObjectsWithPrefix(c, prefix))

    expect(result).toEqual({ deleted: 40, failed: 0, done: true })
    expect(storage.deleteObject).toHaveBeenCalledTimes(40)
    expect(storage.keys).toEqual([])
  })

  it('refuses an empty prefix', async () => {
    await expect(runInContext(c => s3.deleteObjectsWithPrefix(c, ''))).rejects.toThrow('non-empty prefix')
  })
})

describe('DeleteObjects XML', () => {
  it('escapes keys and parses failed keys back', () => {
    const body = buildDeleteObjectsBody(['a&b', '<c>'])
    expect(body).toContain('<Quiet>true</Quiet>')
    expect(body).toContain('<Key>a&amp;b</Key>')
    expect(body).toContain('<Key>&lt;c&gt;</Key>')
    expect(parseDeleteObjectsErrors('<DeleteResult><Error><Key>a&amp;b</Key><Code>InternalError</Code></Error></DeleteResult>')).toEqual(['a&b'])
    expect(parseDeleteObjectsErrors('<DeleteResult><Deleted><Key>x</Key></Deleted></DeleteResult>')).toEqual([])
  })
})
