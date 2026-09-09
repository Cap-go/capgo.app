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

export function isLiveR2Key(key: string): boolean {
  return !key.startsWith(R2_TRASH_PREFIX)
}

/** Per-segment encoding for clients that pass sourceKey into x-amz-copy-source without encoding. */
export function encodeS3LiteCopySourceKey(key: string): string {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export type S3LiteTrashClient = {
  copyObject: (options: { sourceKey: string }, destinationKey: string) => Promise<unknown>
  deleteObject: (key: string) => Promise<unknown>
  statObject: (key: string) => Promise<{ etag: string }>
}

export type S3LiteTrashMoveResult = 'moved' | 'skipped_missing' | 'skipped_changed'

/** Move a live object to 7-day trash via s3_lite_client (encodes copy source path segments). */
export async function moveS3LiteObjectToTrash(s3client: S3LiteTrashClient, key: string): Promise<S3LiteTrashMoveResult> {
  const trashKey = getR2TrashKey(key)
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

  await s3client.copyObject({ sourceKey: encodeS3LiteCopySourceKey(key) }, trashKey)

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

  await s3client.deleteObject(key)
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
