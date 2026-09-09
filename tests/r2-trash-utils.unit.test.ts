import { describe, expect, it, vi } from 'vitest'
import {
  ConcurrencyLimiter,
  conditionalDeleteSource,
  encodeS3CopySource,
  getR2TrashKey,
  getUniqueR2TrashKey,
  isAlreadyMovedToTrash,
  isLiveR2Key,
  isObjectNotFoundError,
  isPreconditionFailedError,
  asS3LiteTrashClient,
  moveS3LiteObjectToTrash,
  resolveOpsDeleteMode,
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

function makeAtomicDeleteClient(etag = '"abc123"') {
  const copyObject = vi.fn(async () => undefined)
  const deleteObject = vi.fn(async () => undefined)
  const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))
  const statObject = vi.fn()
    .mockRejectedValueOnce({ name: 'NotFound' })
    .mockResolvedValue({ etag })
  return { copyObject, deleteObject, makeRequest, statObject }
}

describe('moveS3LiteObjectToTrash', () => {
  it('encodes copy source path segments before moving to trash', async () => {
    const key = 'orgs/org-1/apps/com.test/file name.zip'
    const etag = '"abc123"'
    const { copyObject, deleteObject, makeRequest, statObject } = makeAtomicDeleteClient(etag)

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key)

    expect(result).toBe('moved')
    expect(copyObject).toHaveBeenCalledWith(
      { sourceKey: 'orgs/org-1/apps/com.test/file%20name.zip' },
      `${R2_TRASH_PREFIX}${key}`,
    )
    expect(statObject).toHaveBeenCalledTimes(3)
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(makeRequest.mock.calls[0][0].headers?.get('If-Match')).toBe(etag)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('skips delete when the live object changes after copy', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()
      .mockRejectedValueOnce({ name: 'NotFound' })
      .mockResolvedValueOnce({ etag: '"before"' })
      .mockResolvedValueOnce({ etag: '"after"' })

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key)

    expect(result).toBe('skipped_changed')
    expect(copyObject).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('returns skipped_missing when the source disappears before copy', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const copyObject = vi.fn(async () => {
      throw { status: 404, code: 'not found' }
    })
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()
      .mockRejectedValueOnce({ name: 'NotFound' })
      .mockResolvedValueOnce({ etag: '"before"' })

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key)

    expect(result).toBe('skipped_missing')
    expect(copyObject).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('treats a missing source after copy as already moved', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const statObject = vi.fn()
      .mockRejectedValueOnce({ name: 'NotFound' })
      .mockResolvedValueOnce({ etag: '"before"' })
      .mockRejectedValueOnce({ status: 404, code: 'not found' })

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, statObject }, key)

    expect(result).toBe('moved')
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('uses a unique trash key when the default destination already exists', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))
    const statObject = vi.fn()
      .mockResolvedValueOnce({ etag }) // default trash exists
      .mockRejectedValueOnce({ name: 'NotFound' }) // unique trash destination available
      .mockResolvedValueOnce({ etag }) // source
      .mockResolvedValueOnce({ etag }) // after copy

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key)

    expect(result).toBe('moved')
    expect(copyObject).toHaveBeenCalledOnce()
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
    const copyCalls = copyObject.mock.calls as unknown as Array<[{ sourceKey: string }, string]>
    expect(copyCalls[0][1]).toMatch(new RegExp(`^${R2_TRASH_PREFIX}\\d+-[a-z0-9]+/${key}$`))
  })

  it('retains source when atomic delete loses a concurrent writer race', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const copyObject = vi.fn(async () => undefined)
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })
    const statObject = vi.fn()
      .mockRejectedValueOnce({ name: 'NotFound' })
      .mockResolvedValueOnce({ etag })
      .mockResolvedValueOnce({ etag })

    const result = await moveS3LiteObjectToTrash({ copyObject, deleteObject, makeRequest, statObject }, key)

    expect(result).toBe('skipped_changed')
    expect(copyObject).toHaveBeenCalledOnce()
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(deleteObject).not.toHaveBeenCalled()
  })
})

describe('conditionalDeleteSource', () => {
  it('deletes atomically with If-Match when makeRequest is available', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const etag = '"before"'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => new Response(null, { status: 204 }))

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, etag)

    expect(result).toBe('deleted')
    expect(makeRequest).toHaveBeenCalledOnce()
    expect(makeRequest.mock.calls[0][0].method).toBe('DELETE')
    expect(makeRequest.mock.calls[0][0].objectName).toBe(key)
    expect(makeRequest.mock.calls[0][0].headers?.get('If-Match')).toBe(etag)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when makeRequest is unavailable', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)

    const result = await conditionalDeleteSource({ deleteObject }, key, '"before"')

    expect(result).toBe('skipped_changed')
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('retains source when atomic delete returns precondition failed', async () => {
    const key = 'orgs/org-1/apps/com.test/file.zip'
    const deleteObject = vi.fn(async () => undefined)
    const makeRequest = vi.fn(async () => {
      throw { statusCode: 412, code: 'PreconditionFailed' }
    })

    const result = await conditionalDeleteSource({ deleteObject, makeRequest }, key, '"before"')

    expect(result).toBe('skipped_changed')
    expect(deleteObject).not.toHaveBeenCalled()
  })
})

describe('asS3LiteTrashClient', () => {
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

    await expect(client.deleteObject('key', { ifMatch: '"before"' }))
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
