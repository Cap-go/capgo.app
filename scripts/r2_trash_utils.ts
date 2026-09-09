export type OpsDeleteMode = 'dry_run' | 'trash' | 'permanent'

export const R2_TRASH_PREFIX = 'deleted-after-7-days/'

export function resolveOpsDeleteMode(env: Record<string, string | undefined>): OpsDeleteMode {
  if (env.DRY_RUN !== 'false')
    return 'dry_run'
  if (env.ALLOW_PERMANENT_R2_DELETE === 'true')
    return 'permanent'
  return 'trash'
}

export function getR2TrashKey(sourceKey: string): string {
  if (sourceKey.startsWith(R2_TRASH_PREFIX))
    return sourceKey
  return `${R2_TRASH_PREFIX}${sourceKey}`
}

/** Unique trash destination when the default key already holds a prior deletion. */
export function getUniqueR2TrashKey(sourceKey: string, suffix = Date.now().toString()): string {
  if (sourceKey.startsWith(R2_TRASH_PREFIX))
    return sourceKey
  return `${R2_TRASH_PREFIX}${suffix}/${sourceKey}`
}

export function isLiveR2Key(key: string): boolean {
  return !key.startsWith(R2_TRASH_PREFIX)
}

/** Per-segment encoding for clients that pass sourceKey into x-amz-copy-source without encoding. */
export function encodeS3LiteCopySourceKey(key: string): string {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export type S3LiteTrashClient = {
  copyObject: (options: { sourceKey: string }, destinationKey: string) => Promise<unknown>
  deleteObject: (key: string, options?: { ifMatch?: string }) => Promise<unknown>
  statObject: (key: string) => Promise<{ etag: string }>
}

type RawS3LiteClient = {
  copyObject: S3LiteTrashClient['copyObject']
  deleteObject: (key: string) => Promise<unknown>
  statObject: S3LiteTrashClient['statObject']
  listObjects?: (options: { prefix: string }) => AsyncIterable<{ key: string }>
}

/** Wrap s3_lite_client for trash moves. Listing stays on the raw client. */
export function asS3LiteTrashClient(s3client: RawS3LiteClient): S3LiteTrashClient & Pick<RawS3LiteClient, 'listObjects'> {
  return {
    copyObject: (options, destinationKey) => s3client.copyObject(options, destinationKey),
    statObject: key => s3client.statObject(key),
    // s3_lite has no atomic If-Match delete; callers verify etag immediately before calling.
    deleteObject: async (key, options) => {
      if (options?.ifMatch) {
        const stat = await s3client.statObject(key)
        if (stat.etag !== options.ifMatch)
          throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }
        await s3client.deleteObject(key)
        return
      }
      await s3client.deleteObject(key)
    },
    listObjects: s3client.listObjects,
  }
}

export type S3LiteTrashMoveResult = 'moved' | 'skipped_missing' | 'skipped_changed'

/** Move a live object to 7-day trash via s3_lite_client (encodes copy source path segments). */
export async function moveS3LiteObjectToTrash(s3client: S3LiteTrashClient, key: string): Promise<S3LiteTrashMoveResult> {
  let trashKey = getR2TrashKey(key)
  try {
    await s3client.statObject(trashKey)
    trashKey = getUniqueR2TrashKey(key)
  }
  catch (error) {
    if (!isObjectNotFoundError(error))
      throw error
  }

  let sourceEtag: string | undefined
  try {
    const stat = await s3client.statObject(key)
    sourceEtag = stat.etag
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'skipped_missing'
    throw error
  }

  try {
    await s3client.copyObject({ sourceKey: encodeS3LiteCopySourceKey(key) }, trashKey)
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'skipped_missing'
    throw error
  }

  let afterCopyEtag: string | undefined
  try {
    const afterCopy = await s3client.statObject(key)
    afterCopyEtag = afterCopy.etag
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'moved'
    throw error
  }

  if (sourceEtag && afterCopyEtag !== sourceEtag)
    return 'skipped_changed'

  try {
    await s3client.deleteObject(key)
  }
  catch (error) {
    if (isPreconditionFailedError(error))
      return 'skipped_changed'
    throw error
  }
  return 'moved'
}

/** AWS CopySource: bucket/key with per-segment URL encoding for non-ASCII/reserved chars. */
export function encodeS3CopySource(bucket: string, key: string): string {
  return `${bucket}/${encodeS3LiteCopySourceKey(key)}`
}

export function isAlreadyMovedToTrash(trashExists: boolean, sourceExists: boolean): boolean {
  return trashExists && !sourceExists
}

/** True when delete was skipped because the live object changed after copy (concurrent upload). */
export function isPreconditionFailedError(error: unknown): boolean {
  if (!error || typeof error !== 'object')
    return false

  const err = error as {
    name?: string
    Code?: string
    $metadata?: { httpStatusCode?: number }
  }

  if (err.$metadata?.httpStatusCode === 412)
    return true

  return [err.name, err.Code].some(code => code === 'PreconditionFailed')
}

/** True only for confirmed object-absence from HeadObject (not transient/permission errors). */
export function isObjectNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object')
    return false

  const err = error as {
    name?: string
    Code?: string
    code?: string
    status?: number
    statusCode?: number
    $metadata?: { httpStatusCode?: number }
  }

  if ([err.$metadata?.httpStatusCode, err.status, err.statusCode].includes(404))
    return true

  return [err.name, err.Code, err.code].some(code =>
    code === 'NotFound'
    || code === 'NoSuchKey'
    || code === '404'
    || code === 'not found',
  )
}

export class ConcurrencyLimiter {
  private inFlight = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit)
      await new Promise<void>(resolve => this.queue.push(resolve))

    this.inFlight += 1
    try {
      return await fn()
    }
    finally {
      this.inFlight -= 1
      const next = this.queue.shift()
      if (next)
        next()
    }
  }
}
