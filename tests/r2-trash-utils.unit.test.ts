import { describe, expect, it, vi } from 'vitest'
import {
  ConcurrencyLimiter,
  conditionalDeleteSource,
  createUniqueR2TrashSuffix,
  buildR2ConditionalDeleteHeaders,
  formatR2ConditionalDeleteLastModified,
  permanentDeleteSourceIfMatch,
  quoteS3CopySourceIfMatchEtag,
  copyObjectToTrashWithDestinationGuard,
  encodeS3CopySource,
  getR2TrashKey,
  getUniqueR2TrashKey,
  isAlreadyMovedToTrash,
  isLiveR2Key,
  isObjectNotFoundError,
  isPreconditionFailedError,
  asS3LiteTrashClient,
  copyLiveObjectToTrash,
  moveS3LiteObjectToTrash,
  resolveOpsDeleteMode,
  resolveTrashDestinationKey,
  R2_TRASH_PREFIX,
} from '../scripts/r2_trash_utils.ts'

describe('resolveOpsDeleteMode', () => {
  it('defaults to dry_run', () => {
    expect(resolveOpsDeleteMode({})).toBe('dry_run')
    expect(resolveOpsDeleteMode({ DRY_RUN: 'true' })).toBe('dry_run')
  })

  it('uses trash when executing without permanent flag', () => {
    expect(resolveOpsDeleteMode({ DRY_RUN: 'false' })).toBe('trash')
  })

  it('requires ALLOW_PERMANENT_R2_DELETE=true for permanent mode', () => {
    expect(resolveOpsDeleteMode({
      DRY_RUN: 'false',
      ALLOW_PERMANENT_R2_DELETE: 'true',
    })).toBe('permanent')
  })
})

describe('quoteS3CopySourceIfMatchEtag', () => {
  it('wraps unquoted client etags in quotes for copy preconditions', () => {
    expect(quoteS3CopySourceIfMatchEtag('abc123')).toBe('"abc123"')
    expect(quoteS3CopySourceIfMatchEtag('"already-quoted"')).toBe('"already-quoted"')
  })
})

describe('getR2TrashKey', () => {
  it('prefixes live keys with deleted-after-7-days/', () => {
    expect(getR2TrashKey('orgs/org-1/apps/com.test/1.0.0.zip'))
      .toBe('deleted-after-7-days/orgs/org-1/apps/com.test/1.0.0.zip')
  })

  it('leaves already-trashed keys unchanged', () => {
    const trashed = 'deleted-after-7-days/orgs/org-1/apps/com.test/1.0.0.zip'
    expect(getR2TrashKey(trashed)).toBe(trashed)
  })
})

describe('getUniqueR2TrashKey', () => {
  it('prefixes with a unique suffix to avoid overwriting prior trash copies', () => {
    expect(getUniqueR2TrashKey('orgs/org-1/a.zip', '1700000000'))
      .toBe('deleted-after-7-days/1700000000/orgs/org-1/a.zip')
  })
})

describe('createUniqueR2TrashSuffix', () => {
  it('uses timestamp plus a crypto-random alphanumeric suffix', () => {
    const suffix = createUniqueR2TrashSuffix()
    expect(suffix).toMatch(/^\d+-[0-9a-z]{8}$/)
  })

  it('produces distinct suffixes for concurrent callers', () => {
    const suffixes = new Set(Array.from({ length: 20 }, () => createUniqueR2TrashSuffix()))
    expect(suffixes.size).toBe(20)
  })
})

describe('isLiveR2Key', () => {
  it('treats deleted-after-7-days keys as not live', () => {
    expect(isLiveR2Key(`${R2_TRASH_PREFIX}orgs/org-1/a.zip`)).toBe(false)
    expect(isLiveR2Key('orgs/org-1/a.zip')).toBe(true)
  })
})

describe('isAlreadyMovedToTrash', () => {
  it('is true only when trash exists and source is gone', () => {
    expect(isAlreadyMovedToTrash(true, false)).toBe(true)
    expect(isAlreadyMovedToTrash(true, true)).toBe(false)
    expect(isAlreadyMovedToTrash(false, false)).toBe(false)
    expect(isAlreadyMovedToTrash(false, true)).toBe(false)
  })
})

describe('isPreconditionFailedError', () => {
  it('recognizes conditional delete mismatch errors', () => {
    expect(isPreconditionFailedError({ name: 'PreconditionFailed' })).toBe(true)
    expect(isPreconditionFailedError({ Code: 'PreconditionFailed' })).toBe(true)
    expect(isPreconditionFailedError({ $metadata: { httpStatusCode: 412 } })).toBe(true)
    expect(isPreconditionFailedError({ name: 'NotFound' })).toBe(false)
  })
})

describe('isObjectNotFoundError', () => {
  it('recognizes confirmed absence errors only', () => {
    expect(isObjectNotFoundError({ name: 'NotFound' })).toBe(true)
    expect(isObjectNotFoundError({ name: 'NoSuchKey' })).toBe(true)
    expect(isObjectNotFoundError({ $metadata: { httpStatusCode: 404 } })).toBe(true)
    expect(isObjectNotFoundError({ Code: 'NoSuchKey' })).toBe(true)
    expect(isObjectNotFoundError({ Code: '404' })).toBe(true)
    expect(isObjectNotFoundError({ name: 'AccessDenied', Code: 'NoSuchKey' })).toBe(false)
    expect(isObjectNotFoundError({ name: 'AccessDenied' })).toBe(false)
    expect(isObjectNotFoundError({ $metadata: { httpStatusCode: 503 } })).toBe(false)
    expect(isObjectNotFoundError(null)).toBe(false)
    expect(isObjectNotFoundError('NotFound')).toBe(false)
    expect(isObjectNotFoundError({ status: 404 })).toBe(true)
    expect(isObjectNotFoundError({ statusCode: 404 })).toBe(true)
    expect(isObjectNotFoundError({ code: 'not found' })).toBe(true)
  })
})

type MakeRequestArgs = {
  method: string
  objectName: string
  headers?: Headers
}

const DEFAULT_LAST_MODIFIED = new Date('2024-01-15T10:30:00.000Z')
const TEST_S3_BUCKET = 'capgo'

function stat(etag: string, lastModified = DEFAULT_LAST_MODIFIED) {
  return { etag, lastModified }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeAtomicDeleteClient(etag = '"abc123"') {
  const copyObject = vi.fn(async () => undefined)
  const deleteObject = vi.fn(async () => undefined)
  const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => new Response(null, { status: 204 }))
  const statObject = vi.fn()
    .mockResolvedValueOnce(stat(etag)) // source
    .mockRejectedValueOnce({ name: 'NotFound' }) // default trash slot free
    .mockResolvedValue(stat(etag)) // after copy + follow-up stat
  return { copyObject, deleteObject, makeRequest, statObject }
}

describe('moveS3LiteObjectToTrash', () => {
  it('encodes copy source path segments before moving to trash', async () => {
    const key = 'orgs/org-1/apps/com.test/file name.zip'
    const etag = '"abc123"'
    const { copyObject, deleteObject, makeRequest, statObject } = makeAtomicDeleteClient(etag)

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('moved')
    expect(copyObject).not.toHaveBeenCalled()
    expect(statObject).toHaveBeenCalledTimes(3)
    expect(makeRequest).toHaveBeenCalledTimes(2)
    const copyCall = makeRequest.mock.calls[0]![0]
    expect(copyCall.method).toBe('PUT')
    expect(copyCall.objectName).toBe(`${R2_TRASH_PREFIX}${key}`)
    expect(copyCall.headers?.get('x-amz-copy-source')).toBe(`${TEST_S3_BUCKET}/orgs/org-1/apps/com.test/file%20name.zip`)
    expect(copyCall.headers?.get('x-amz-copy-source-if-match')).toBe(etag)
    expect(copyCall.headers?.get('cf-copy-destination-if-none-match')).toBe('*')
    const deleteCall = makeRequest.mock.calls[1]![0]
    expect(deleteCall.headers?.get('x-amz-if-match-last-modified-time'))
      .toBe(formatR2ConditionalDeleteLastModified(DEFAULT_LAST_MODIFIED))
    expect(deleteCall.headers?.get('If-Match')).toBe(etag)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('quotes unquoted etags on conditional delete If-Match headers', async () => {
    const headers = buildR2ConditionalDeleteHeaders({ etag: 'unquoted-etag', lastModified: DEFAULT_LAST_MODIFIED })
    expect(headers['If-Match']).toBe('"unquoted-etag"')
  })

  it('skips delete when the live object changes after copy', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat('"before"')) // source
      .mockRejectedValueOnce({ name: 'NotFound' }) // default trash slot
      .mockResolvedValueOnce(stat('"after"')) // changed after copy

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('skipped_changed')
    expect(copyObject).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('skips delete when Last-Modified changes but etag stays the same after copy', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"same"'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat(etag, new Date('2024-01-15T10:30:00.000Z'))) // source
      .mockRejectedValueOnce({ name: 'NotFound' }) // default trash slot
      .mockResolvedValueOnce(stat(etag, new Date('2024-01-15T10:30:01.000Z'))) // replaced in same second bucket

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('skipped_changed')
    expect(makeRequest).toHaveBeenCalledOnce()
  })

  it('returns skipped_missing when the source disappears before copy', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const copyObject = vi.fn(async () => {
      throw { status: 404, code: 'not found' }
    })
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat('"before"')) // source
      .mockRejectedValueOnce({ name: 'NotFound' }) // default trash slot

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('skipped_missing')
    expect(copyObject).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('treats a missing source after copy as already moved', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat('"before"')) // source
      .mockRejectedValueOnce({ name: 'NotFound' }) // default trash slot
      .mockRejectedValueOnce({ status: 404, code: 'not found' }) // gone after copy

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('moved')
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('reuses the default trash key when it already holds the same source etag', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => new Response(null, { status: 204 }))
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat(etag)) // source
      .mockResolvedValueOnce(stat(etag)) // default trash exists
      .mockResolvedValueOnce(stat(etag)) // default trash etag
      .mockResolvedValue(stat(etag)) // after copy + any follow-up stat

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('moved')
    expect(makeRequest).toHaveBeenCalledTimes(2)
    const copyCall = makeRequest.mock.calls[0]![0]!
    expect(copyCall.method).toBe('PUT')
    expect(copyCall.objectName).toBe(`${R2_TRASH_PREFIX}${key}`)
    expect(copyCall.headers?.get('x-amz-copy-source-if-match')).toBe(etag)
    expect(copyObject).not.toHaveBeenCalled()
  })

  it('uses a unique trash key when the default destination holds a different object', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => new Response(null, { status: 204 }))
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat(etag)) // source
      .mockResolvedValueOnce(stat('"other"')) // default trash exists
      .mockResolvedValueOnce(stat('"other"')) // default trash etag
      .mockRejectedValueOnce({ name: 'NotFound' }) // unique candidate free
      .mockResolvedValue(stat(etag)) // after copy + any follow-up stat

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('moved')
    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(deleteObject).not.toHaveBeenCalled()
    const copyCall = makeRequest.mock.calls[0]![0]!
    expect(copyCall.objectName).toMatch(new RegExp(`^${R2_TRASH_PREFIX}\\d+-[a-z0-9]+/${escapeRegExp(key)}$`))
  })

  it('retains source when atomic delete loses a concurrent writer race', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async (options: MakeRequestArgs) => {
      if (options.method === 'DELETE')
        throw { statusCode: 412, code: 'PreconditionFailed' }
      return new Response(null, { status: 204 })
    })
    const statObject = vi.fn()
      .mockResolvedValueOnce(stat(etag)) // source
      .mockRejectedValueOnce({ name: 'NotFound' }) // default trash slot
      .mockResolvedValue(stat(etag)) // after copy

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('skipped_changed')
    expect(copyObject).not.toHaveBeenCalled()
    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('returns moved for keys already under deleted-after-7-days/', async () => {
    const key = `${R2_TRASH_PREFIX}orgs/org-1/apps/com.test/file.zip`
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key, TEST_S3_BUCKET)

    expect(result).toBe('moved')
    expect(statObject).not.toHaveBeenCalled()
    expect(copyObject).not.toHaveBeenCalled()
  })
})

describe('copyLiveObjectToTrash', () => {
  it('treats destination precondition conflicts as success when trash already holds the same etag', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"same"'
    const trashKey = `${R2_TRASH_PREFIX}${key}`
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })
    const statObject = vi.fn(async (objectKey: string) => {
      if (objectKey === trashKey)
        return stat(etag)
      throw { name: 'NotFound' }
    })

    const destination = await copyLiveObjectToTrash(
      { copyObject: vi.fn(), makeRequest, statObject },
      key,
      trashKey,
      etag,
      TEST_S3_BUCKET,
    )

    expect(destination).toBe(trashKey)
    expect(makeRequest).toHaveBeenCalledOnce()
  })

  it('quotes unquoted source etags on the copy precondition header', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => new Response(null, { status: 200 }))
    const statObject = vi.fn(async () => stat('unquoted-etag'))

    await copyLiveObjectToTrash(
      { copyObject: vi.fn(), makeRequest, statObject },
      key,
      `${R2_TRASH_PREFIX}${key}`,
      'unquoted-etag',
      TEST_S3_BUCKET,
    )

    expect(makeRequest.mock.calls[0]![0]!.headers?.get('x-amz-copy-source-if-match')).toBe('"unquoted-etag"')
  })

  it('retries with a unique trash key when destination precondition conflicts with a different object', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"source"'
    const trashKey = `${R2_TRASH_PREFIX}${key}`
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async (options) => {
      if (options.objectName === trashKey)
        throw { statusCode: 412, code: 'PreconditionFailed' }
      return new Response(null, { status: 200 })
    })
    const statObject = vi.fn(async (objectKey: string) => {
      if (objectKey === trashKey)
        return stat('"other"')
      throw { name: 'NotFound' }
    })

    const destination = await copyLiveObjectToTrash(
      { copyObject: vi.fn(), makeRequest, statObject },
      key,
      trashKey,
      etag,
      TEST_S3_BUCKET,
    )

    expect(destination).not.toBe(trashKey)
    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(makeRequest.mock.calls[1]![0]!.headers?.get('cf-copy-destination-if-none-match')).toBe('*')
  })

  it('fails closed when the destination slot is empty after a copy precondition conflict', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"source"'
    const trashKey = `${R2_TRASH_PREFIX}${key}`
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })
    const statObject = vi.fn(async (objectKey: string) => {
      if (objectKey === trashKey)
        throw { name: 'NotFound' }
      return stat(etag)
    })

    await expect(copyLiveObjectToTrash(
      { copyObject: vi.fn(), makeRequest, statObject },
      key,
      trashKey,
      etag,
      TEST_S3_BUCKET,
    )).rejects.toMatchObject({ name: 'SourceChangedBeforeTrashCopy' })
  })
})

describe('copyObjectToTrashWithDestinationGuard', () => {
  it('retries with a unique destination when the default trash slot is occupied', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"source"'
    const defaultTrashKey = `${R2_TRASH_PREFIX}${key}`
    const copy = vi.fn(async (destinationKey: string) => {
      if (destinationKey === defaultTrashKey)
        throw { statusCode: 412, code: 'PreconditionFailed' }
    })
    const headDestination = vi.fn(async (destinationKey: string) => {
      if (destinationKey === defaultTrashKey)
        return { etag: '"other"' }
      return 'not_found'
    })

    const result = await copyObjectToTrashWithDestinationGuard(
      key,
      defaultTrashKey,
      etag,
      copy,
      headDestination,
    )

    expect(result).not.toBe('skipped_changed')
    if (result !== 'skipped_changed')
      expect(result.trashKey).not.toBe(defaultTrashKey)
    expect(copy).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the source changes before copy and the destination slot is empty', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"source"'
    const defaultTrashKey = `${R2_TRASH_PREFIX}${key}`

    const result = await copyObjectToTrashWithDestinationGuard(
      key,
      defaultTrashKey,
      etag,
      async () => {
        throw { statusCode: 412, code: 'PreconditionFailed' }
      },
      async () => 'not_found',
    )

    expect(result).toBe('skipped_changed')
  })

  it('reuses the destination when etag and Last-Modified both match the source', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"source"'
    const lastModified = new Date('2024-01-15T10:30:00.000Z')
    const defaultTrashKey = `${R2_TRASH_PREFIX}${key}`
    const copy = vi.fn(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })

    const result = await copyObjectToTrashWithDestinationGuard(
      key,
      defaultTrashKey,
      etag,
      copy,
      async () => ({ etag, lastModified }),
      lastModified,
    )

    expect(result).toEqual({ trashKey: defaultTrashKey })
    expect(copy).toHaveBeenCalledOnce()
  })

  it('allocates a unique destination when etag matches but Last-Modified differs', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"source"'
    const lastModified = new Date('2024-01-15T10:30:00.000Z')
    const defaultTrashKey = `${R2_TRASH_PREFIX}${key}`
    const copy = vi.fn(async (destinationKey: string) => {
      if (destinationKey === defaultTrashKey)
        throw { statusCode: 412, code: 'PreconditionFailed' }
    })

    const result = await copyObjectToTrashWithDestinationGuard(
      key,
      defaultTrashKey,
      etag,
      copy,
      async () => ({ etag, lastModified: new Date('2024-01-15T10:30:01.000Z') }),
      lastModified,
    )

    expect(result).not.toBe('skipped_changed')
    if (result !== 'skipped_changed')
      expect(result.trashKey).not.toBe(defaultTrashKey)
    expect(copy).toHaveBeenCalledTimes(2)
  })
})

describe('conditionalDeleteSource', () => {
  it('deletes conditionally with x-amz-if-match-last-modified-time when makeRequest is available', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => new Response(null, { status: 204 }))

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, etag, DEFAULT_LAST_MODIFIED)

    expect(result).toBe('deleted')
    expect(makeRequest).toHaveBeenCalledOnce()
    const deleteCall = makeRequest.mock.calls[0]![0]
    expect(deleteCall.method).toBe('DELETE')
    expect(deleteCall.objectName).toBe(key)
    expect(deleteCall.headers?.get('x-amz-if-match-last-modified-time'))
      .toBe(formatR2ConditionalDeleteLastModified(DEFAULT_LAST_MODIFIED))
    expect(deleteCall.headers?.get('If-Match')).toBe(etag)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('buildR2ConditionalDeleteHeaders includes Last-Modified and If-Match guards', () => {
    const etag = '"before"'
    const headers = buildR2ConditionalDeleteHeaders({ etag, lastModified: DEFAULT_LAST_MODIFIED })
    expect(headers['x-amz-if-match-last-modified-time']).toBe(formatR2ConditionalDeleteLastModified(DEFAULT_LAST_MODIFIED))
    expect(headers['If-Match']).toBe(etag)
  })

  it('retains source when makeRequest is unavailable', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)

    const result = await conditionalDeleteSource({ deleteObject }, key, '"before"', DEFAULT_LAST_MODIFIED)

    expect(result).toBe('skipped_changed')
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('treats not-found during atomic delete as skipped_missing', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => {
      throw { statusCode: 404, code: 'NotFound' }
    })

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, '"before"', DEFAULT_LAST_MODIFIED)

    expect(result).toBe('skipped_missing')
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when atomic delete returns precondition failed', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, '"before"', DEFAULT_LAST_MODIFIED)

    expect(result).toBe('skipped_changed')
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when expected etag is missing', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, undefined, DEFAULT_LAST_MODIFIED)

    expect(result).toBe('skipped_changed')
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when lastModified is missing', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, '"before"')

    expect(result).toBe('skipped_changed')
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })
})

describe('permanentDeleteSourceIfMatch', () => {
  it('deletes permanently when the live etag still matches', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const statObject = vi.fn(async () => stat(etag))
    const deleteObject = vi.fn()
    const makeRequest = vi.fn<(args: MakeRequestArgs) => Promise<Response>>(async () => new Response(null, { status: 204 }))

    const result = await permanentDeleteSourceIfMatch({ statObject, deleteObject, makeRequest }, key, etag)

    expect(result).toBe('deleted')
    expect(makeRequest).toHaveBeenCalledOnce()
    const deleteCall = makeRequest.mock.calls[0]![0]
    expect(deleteCall.headers?.get('x-amz-if-match-last-modified-time'))
      .toBe(formatR2ConditionalDeleteLastModified(DEFAULT_LAST_MODIFIED))
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('skips idempotently when the source is already absent', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const statObject = vi.fn(async () => {
      throw { statusCode: 404, code: 'NotFound' }
    })
    const deleteObject = vi.fn()
    const makeRequest = vi.fn()

    const result = await permanentDeleteSourceIfMatch({ statObject, deleteObject, makeRequest }, key, '"before"')

    expect(result).toBe('skipped_missing')
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains the source when a concurrent writer wins the etag race', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const statObject = vi.fn(async () => stat('"before"'))
    const deleteObject = vi.fn()
    const makeRequest = vi.fn(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })

    const result = await permanentDeleteSourceIfMatch({ statObject, deleteObject, makeRequest }, key, '"before"')

    expect(result).toBe('skipped_changed')
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains the source when the live object has no etag', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const statObject = vi.fn(async () => ({ etag: '', lastModified: DEFAULT_LAST_MODIFIED }))
    const deleteObject = vi.fn()
    const makeRequest = vi.fn()

    const result = await permanentDeleteSourceIfMatch({ statObject, deleteObject, makeRequest }, key, '"before"')

    expect(result).toBe('skipped_changed')
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains the source when discovery etag does not match the live object', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const statObject = vi.fn(async () => stat('"current"'))
    const deleteObject = vi.fn()
    const makeRequest = vi.fn()

    const result = await permanentDeleteSourceIfMatch(
      { statObject, deleteObject, makeRequest },
      key,
      '"stale-discovery"',
    )

    expect(result).toBe('skipped_changed')
    expect(makeRequest).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })
})

describe('resolveTrashDestinationKey', () => {
  it('uses the default trash key when the default trash slot is free', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const exists = vi.fn(async () => false)
    const getEtag = vi.fn(async () => '"etag"')

    const trashKey = await resolveTrashDestinationKey({ keyExists: exists, getEtag }, key, '"etag"')

    expect(trashKey).toBe(getR2TrashKey(key))
  })

  it('reuses the default trash key when it already holds the same source etag and Last-Modified', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"same"'
    const lastModified = new Date('2024-01-15T10:30:00.000Z')
    const exists = vi.fn(async (trashKey: string) => trashKey === getR2TrashKey(key))
    const getEtag = vi.fn(async () => etag)
    const getLastModified = vi.fn(async () => lastModified)

    const trashKey = await resolveTrashDestinationKey({ keyExists: exists, getEtag, getLastModified }, key, etag, lastModified)

    expect(trashKey).toBe(getR2TrashKey(key))
  })

  it('allocates a unique path when the default trash key matches etag but not Last-Modified', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"same"'
    const exists = vi.fn(async (trashKey: string) => trashKey === getR2TrashKey(key))
    const getEtag = vi.fn(async () => etag)
    const getLastModified = vi.fn(async () => new Date('2024-01-15T10:30:01.000Z'))

    const trashKey = await resolveTrashDestinationKey({ keyExists: exists, getEtag, getLastModified }, key, etag, new Date('2024-01-15T10:30:00.000Z'))

    expect(trashKey).toMatch(new RegExp(`^${R2_TRASH_PREFIX}\\d+-[a-z0-9]+/${escapeRegExp(key)}$`))
  })

  it('allocates a unique path when the default trash key holds a different etag', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const exists = vi.fn(async (trashKey: string) => trashKey === getR2TrashKey(key))
    const getEtag = vi.fn(async (trashKey: string) => trashKey === getR2TrashKey(key) ? '"other"' : undefined)

    const trashKey = await resolveTrashDestinationKey({ keyExists: exists, getEtag }, key, '"current"')

    expect(trashKey).toMatch(new RegExp(`^${R2_TRASH_PREFIX}\\d+-[a-z0-9]+/${escapeRegExp(key)}$`))
  })
})

describe('asS3LiteTrashClient', () => {
  it('binds listObjects to the raw client', async () => {
    async function* listObjects() {
      yield { key: 'orgs/org-1/a.zip' }
    }
    const raw = {
      copyObject: vi.fn(),
      statObject: vi.fn(),
      deleteObject: vi.fn(),
      listObjects,
    }
    const client = asS3LiteTrashClient(raw)
    const keys: string[] = []
    for await (const obj of client.listObjects!({ prefix: 'orgs/' }))
      keys.push(obj.key)
    expect(keys).toEqual(['orgs/org-1/a.zip'])
  })

  it('rejects delete when atomic If-Match delete fails', async () => {
    const raw = {
      copyObject: vi.fn(),
      statObject: vi.fn(),
      deleteObject: vi.fn(),
      makeRequest: vi.fn(async () => {
        throw { statusCode: 412, code: 'PreconditionFailed' }
      }),
    }
    const client = asS3LiteTrashClient(raw)

    await expect(client.deleteObject('key', { ifMatch: '"before"', lastModified: DEFAULT_LAST_MODIFIED }))
      .rejects.toEqual({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
    expect(raw.deleteObject).not.toHaveBeenCalled()
    expect(raw.makeRequest).toHaveBeenCalledOnce()
  })

  it('retains source when ifMatch delete is requested without makeRequest', async () => {
    const raw = {
      copyObject: vi.fn(),
      statObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    const client = asS3LiteTrashClient(raw)

    await expect(client.deleteObject('key', { ifMatch: '"before"' }))
      .rejects.toEqual({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
    expect(raw.deleteObject).not.toHaveBeenCalled()
  })
})

describe('encodeS3CopySource', () => {
  it('URL-encodes reserved characters per path segment', () => {
    expect(encodeS3CopySource('capgo', 'orgs/org-1/apps/com.test/file name.zip'))
      .toBe('capgo/orgs/org-1/apps/com.test/file%20name.zip')
    expect(encodeS3CopySource('capgo', 'orgs/org-1/apps/com.test/文件.zip'))
      .toBe('capgo/orgs/org-1/apps/com.test/%E6%96%87%E4%BB%B6.zip')
  })
})

describe('ConcurrencyLimiter', () => {
  it('caps concurrent work to the configured limit', async () => {
    const limiter = new ConcurrencyLimiter(2)
    let inFlight = 0
    let maxInFlight = 0

    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight -= 1
    })))

    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(maxInFlight).toBeGreaterThan(1)
  })
})
