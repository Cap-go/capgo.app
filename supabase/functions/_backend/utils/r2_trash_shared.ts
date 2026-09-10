export type OpsDeleteMode = 'dry_run' | 'trash' | 'permanent'

export type DeleteFileCandidate = { key: string, etag?: string }

/** Legacy `apps/{userId}/{appId}/{segment}/{version}.zip` keys from check_r2 discovery. */
export function parseLegacyAppsBundleKey(key: string): { appId: string, versionName: string } | null {
  if (!key.startsWith('apps/'))
    return null
  const parts = key.split('/')
  if (parts.length !== 5 || !parts[1] || !parts[2] || !parts[3])
    return null
  const fileName = parts[4]
  if (!fileName?.endsWith('.zip'))
    return null
  const versionName = fileName.slice(0, -4)
  if (!versionName)
    return null
  const appId = parts[2]
  if (!appId)
    return null
  return { appId, versionName }
}

/** Keep PostgREST `.in()` batches small enough for gateway URL limits. */
const REVALIDATION_BATCH_SIZE = 50

/** Live app_versions row predicate (negation of isVersionDeleted); NULL deleted counts as active. */
export const APP_VERSION_NOT_DELETED_SQL = 'deleted IS NOT TRUE AND deleted_at IS NULL'

/** Drop candidates that now have app_versions rows (shared by dry-run and execute paths). */
export async function revalidateDeleteCandidatesAgainstAppVersions(
  candidates: DeleteFileCandidate[],
  lookupExistingPaths: (batch: string[]) => Promise<string[]>,
): Promise<{ candidates: DeleteFileCandidate[], skippedCount: number }> {
  const existingPaths = new Set<string>()
  const candidateKeys = candidates.map(candidate => candidate.key)

  for (let i = 0; i < candidateKeys.length; i += REVALIDATION_BATCH_SIZE) {
    const batch = candidateKeys.slice(i, i + REVALIDATION_BATCH_SIZE)
    const paths = await lookupExistingPaths(batch)
    for (const path of paths)
      existingPaths.add(path)
  }

  const beforeCount = candidates.length
  const revalidated = candidates.filter(candidate => !existingPaths.has(candidate.key))
  return { candidates: revalidated, skippedCount: beforeCount - revalidated.length }
}

export const R2_TRASH_PREFIX = 'deleted-after-7-days/'

/** User metadata key stamped on trash copies for idempotent reuse (copy time != source LM). */
export const R2_TRASH_SOURCE_LM_METADATA_KEY = 'capgo-source-last-modified'

export function formatR2TrashSourceVersionMarker(lastModified: Date): string {
  return lastModified.toISOString()
}

export function parseR2TrashSourceVersionMarker(marker: string | undefined): Date | undefined {
  if (!marker)
    return undefined
  const parsed = new Date(marker)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export function extractR2TrashSourceVersionMarker(metadata?: Record<string, string> | null): string | undefined {
  if (!metadata)
    return undefined
  return metadata[R2_TRASH_SOURCE_LM_METADATA_KEY]
}

export function buildAwsTrashCopyMetadata(sourceLastModified: Date): Record<string, string> {
  return {
    [R2_TRASH_SOURCE_LM_METADATA_KEY]: formatR2TrashSourceVersionMarker(sourceLastModified),
  }
}

export function mergeTrashCopyMetadata(
  existingMetadata: Record<string, string> | undefined,
  sourceLastModified: Date,
): Record<string, string> {
  return {
    ...(existingMetadata ?? {}),
    ...buildAwsTrashCopyMetadata(sourceLastModified),
  }
}

export type S3ObjectCopyPreserve = {
  metadata?: Record<string, string>
  contentType?: string
  cacheControl?: string
  contentEncoding?: string
  contentDisposition?: string
  expires?: Date
}

export function buildAwsTrashCopyPreserveFromHead(head: {
  Metadata?: Record<string, string>
  ContentType?: string
  CacheControl?: string
  ContentEncoding?: string
  ContentDisposition?: string
  Expires?: Date
}): S3ObjectCopyPreserve {
  return {
    metadata: head.Metadata,
    contentType: head.ContentType,
    cacheControl: head.CacheControl,
    contentEncoding: head.ContentEncoding,
    contentDisposition: head.ContentDisposition,
    expires: head.Expires,
  }
}

export function applyR2TrashCopyMetadataHeaders(
  headers: Headers,
  sourceLastModified: Date,
  preserve?: S3ObjectCopyPreserve,
): void {
  headers.set('x-amz-metadata-directive', 'REPLACE')
  if (preserve?.contentType)
    headers.set('Content-Type', preserve.contentType)
  if (preserve?.cacheControl)
    headers.set('Cache-Control', preserve.cacheControl)
  if (preserve?.contentEncoding)
    headers.set('Content-Encoding', preserve.contentEncoding)
  if (preserve?.contentDisposition)
    headers.set('Content-Disposition', preserve.contentDisposition)
  if (preserve?.expires)
    headers.set('Expires', preserve.expires.toUTCString())
  const merged = mergeTrashCopyMetadata(preserve?.metadata, sourceLastModified)
  for (const [key, value] of Object.entries(merged))
    headers.set(`x-amz-meta-${key}`, value)
}

async function headS3LiteObjectCopyPreserve(
  s3client: Pick<RawS3LiteClient, 'makeRequest'>,
  objectKey: string,
): Promise<S3ObjectCopyPreserve | undefined> {
  if (!s3client.makeRequest)
    return undefined
  try {
    const response = await s3client.makeRequest({
      method: 'HEAD',
      objectName: objectKey,
      returnBody: true,
    })
    const metadata: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (key.startsWith('x-amz-meta-'))
        metadata[key.slice('x-amz-meta-'.length)] = value
    })
    const expiresHeader = response.headers.get('expires')
    const preserve: S3ObjectCopyPreserve = {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      contentType: response.headers.get('content-type') ?? undefined,
      cacheControl: response.headers.get('cache-control') ?? undefined,
      contentEncoding: response.headers.get('content-encoding') ?? undefined,
      contentDisposition: response.headers.get('content-disposition') ?? undefined,
      expires: expiresHeader ? new Date(expiresHeader) : undefined,
    }
    if (!preserve.metadata && !preserve.contentType && !preserve.cacheControl
      && !preserve.contentEncoding && !preserve.contentDisposition && !preserve.expires)
      return undefined
    return preserve
  }
  catch {
    // Best-effort: copy still runs; missing metadata is acceptable on transient HEAD errors.
    return undefined
  }
}

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

function randomAlphanumericSuffix(length = 8): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes)
    out += alphabet[byte % alphabet.length]
  return out
}

/** Collision-resistant suffix for same-ms concurrent trash moves. */
export function createUniqueR2TrashSuffix(): string {
  return `${Date.now()}-${randomAlphanumericSuffix()}`
}

/** Unique trash destination when the default key already holds a prior deletion. */
export function getUniqueR2TrashKey(sourceKey: string, suffix?: string): string {
  if (sourceKey.startsWith(R2_TRASH_PREFIX))
    return sourceKey
  return `${R2_TRASH_PREFIX}${suffix ?? createUniqueR2TrashSuffix()}/${sourceKey}`
}

export type TrashDestinationResolver = {
  keyExists: (key: string) => Promise<boolean>
  getEtag: (key: string) => Promise<string | undefined>
  getSourceVersionMarker?: (key: string) => Promise<string | undefined>
}

/** S3 CopySourceIfMatch expects a quoted entity tag; s3-lite may return unquoted values. */
export function quoteS3CopySourceIfMatchEtag(etag: string): string {
  const trimmed = etag.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed
  return `"${trimmed.replaceAll('"', '')}"`
}

function normalizeS3Etag(etag: string | undefined): string | undefined {
  if (!etag)
    return undefined
  return quoteS3CopySourceIfMatchEtag(etag)
}

export function normalizedS3EtagsMatch(a?: string, b?: string): boolean {
  if (!a || !b)
    return false
  return normalizeS3Etag(a) === normalizeS3Etag(b)
}

/** Build a TrashDestinationResolver from a HeadObject-style callback. */
export function createAwsTrashDestinationResolver(
  headObject: (key: string) => Promise<{ etag?: string, lastModified?: Date, metadata?: Record<string, string> }>,
): TrashDestinationResolver {
  return {
    keyExists: async (key) => {
      try {
        await headObject(key)
        return true
      }
      catch (error) {
        if (isObjectNotFoundError(error))
          return false
        throw error
      }
    },
    getEtag: async (key) => {
      const head = await headObject(key)
      return head.etag
    },
    getSourceVersionMarker: async (key) => {
      const head = await headObject(key)
      return extractR2TrashSourceVersionMarker(head.metadata)
    },
  }
}

/**
 * Pick a trash destination without concurrent default-key overwrites.
 * Uses the default trash key when free, or when it already holds this source etag (idempotent rerun).
 * Otherwise allocates a unique suffix path.
 */
export async function resolveTrashDestinationKey(
  resolver: TrashDestinationResolver,
  sourceKey: string,
  sourceEtag?: string,
  sourceLastModified?: Date,
  maxUniqueAttempts = 10,
): Promise<string> {
  const defaultTrashKey = getR2TrashKey(sourceKey)
  if (!await resolver.keyExists(defaultTrashKey))
    return defaultTrashKey

  const trashEtag = await resolver.getEtag(defaultTrashKey)
  if (sourceEtag && sourceLastModified && resolver.getSourceVersionMarker && normalizedS3EtagsMatch(trashEtag, sourceEtag)) {
    const trashMarker = await resolver.getSourceVersionMarker(defaultTrashKey)
    const trashSourceLastModified = parseR2TrashSourceVersionMarker(trashMarker)
    if (trashSourceLastModified?.getTime() === sourceLastModified.getTime())
      return defaultTrashKey
  }

  for (let i = 0; i < maxUniqueAttempts; i++) {
    const candidate = getUniqueR2TrashKey(sourceKey)
    if (!await resolver.keyExists(candidate))
      return candidate
  }

  throw new Error(`Failed to allocate unique trash destination for ${sourceKey}`)
}

/** RFC 3339 timestamp for R2 DeleteObject conditional deletes (x-amz-if-match-last-modified-time). */
export function formatR2ConditionalDeleteLastModified(lastModified: Date): string {
  return lastModified.toISOString()
}

/** Normalize S3 list/JSON LastModified values (Date or ISO string) for conditional guards. */
export function parseS3ListingLastModified(value: Date | string | undefined | null): Date | undefined {
  if (!value)
    return undefined
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? undefined : value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export function parseVersionScopedR2Key(key: string): { appId: string, versionName: string } | null {
  const orgScoped = key.match(/^orgs\/[^/]+\/apps\/([^/]+)\/([^/]+)\.zip$/)
  if (orgScoped)
    return { appId: orgScoped[1], versionName: orgScoped[2] }
  return parseLegacyAppsBundleKey(key)
}

export type PgQueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null, rows: unknown[] }>
}

/**
 * Hold a version-scoped row lock while deleting an orphan key so upload cannot
 * assign app_versions.r2_path between the reference check and DeleteObject.
 */
export async function withOrphanR2DeleteClaim<T>(
  client: PgQueryClient,
  key: string,
  runDelete: () => Promise<T>,
): Promise<'skipped_referenced' | T> {
  const scope = parseVersionScopedR2Key(key)
  await client.query('BEGIN')
  try {
    if (scope) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`orphan-r2:${scope.appId}`, scope.versionName],
      )
      await client.query(
        'SELECT 1 FROM public.apps WHERE app_id = $1 FOR UPDATE',
        [scope.appId],
      )
      const locked = await client.query(
        `SELECT r2_path FROM public.app_versions
         WHERE app_id = $1 AND name = $2 AND ${APP_VERSION_NOT_DELETED_SQL}
         FOR UPDATE`,
        [scope.appId, scope.versionName],
      )
      if ((locked.rowCount ?? 0) > 0) {
        const row = locked.rows[0] as { r2_path: string | null }
        if (row.r2_path === key) {
          await client.query('ROLLBACK')
          return 'skipped_referenced'
        }
      }
    }

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['orphan-r2:path', key],
    )

    const byPath = await client.query(
      `SELECT 1 FROM public.app_versions
       WHERE r2_path = $1 AND ${APP_VERSION_NOT_DELETED_SQL}
       LIMIT 1
       FOR UPDATE`,
      [key],
    )
    if ((byPath.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK')
      return 'skipped_referenced'
    }

    const result = await runDelete()
    await client.query('COMMIT')
    return result
  }
  catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export type R2ConditionalDeleteMatch = {
  etag: string
  lastModified: Date
}

/** Headers for R2 DeleteObject: Last-Modified guard + If-Match stale-candidate guard. */
export function buildR2ConditionalDeleteHeaders(match: R2ConditionalDeleteMatch): Record<string, string> {
  return {
    'x-amz-if-match-last-modified-time': formatR2ConditionalDeleteLastModified(match.lastModified),
    'If-Match': quoteS3CopySourceIfMatchEtag(match.etag),
  }
}

type AwsMiddlewareStack = {
  add: (
    middleware: (next: (args: unknown) => Promise<unknown>) => (args: unknown) => Promise<unknown>,
    options: { step: 'build', name: string },
  ) => void
}

/** Attach R2 conditional-delete headers to an AWS SDK v3 command middleware stack. */
export function applyR2ConditionalDeleteMiddleware(
  middlewareStack: AwsMiddlewareStack,
  match: R2ConditionalDeleteMatch,
): void {
  const headers = buildR2ConditionalDeleteHeaders(match)
  middlewareStack.add(
    next => (args) => {
      const request = (args as { request?: { headers?: Record<string, string> } }).request
      if (request?.headers) {
        for (const [key, value] of Object.entries(headers))
          request.headers[key] = value
      }
      return next(args)
    },
    { step: 'build', name: 'r2ConditionalDeleteHeaders' },
  )
}

/** Reserve trash destination slots during AWS SDK CopyObject (R2 extension). */
export function applyAwsCopyDestinationIfNoneMatchMiddleware(middlewareStack: AwsMiddlewareStack): void {
  middlewareStack.add(
    next => (args) => {
      const request = (args as { request?: { headers?: Record<string, string> } }).request
      if (request?.headers)
        request.headers['cf-copy-destination-if-none-match'] = '*'
      return next(args)
    },
    { step: 'build', name: 'awsCopyDestinationIfNoneMatch' },
  )
}

export type TrashCopyAttemptResult = { trashKey: string } | 'skipped_changed'

export type TrashDestinationHead = { etag?: string, sourceVersionMarker?: string } | 'not_found'

function trashDestinationMatchesSource(
  destinationStat: Exclude<TrashDestinationHead, 'not_found'>,
  sourceEtag: string,
  sourceLastModified?: Date,
): boolean {
  if (!normalizedS3EtagsMatch(destinationStat.etag, sourceEtag))
    return false
  if (!sourceLastModified)
    return false
  const destinationSourceLastModified = parseR2TrashSourceVersionMarker(destinationStat.sourceVersionMarker)
  if (!destinationSourceLastModified)
    return false
  return destinationSourceLastModified.getTime() === sourceLastModified.getTime()
}

function guardedCopyDestinationMatchesSource(
  destinationStat: { etag?: string, lastModified?: Date },
  sourceEtag: string,
  _sourceLastModified?: Date,
): boolean {
  // Owner-copy destinations get a fresh Last-Modified; match etag only for resume.
  return normalizedS3EtagsMatch(destinationStat.etag, sourceEtag)
}

/**
 * Copy a live object into trash with destination-if-none-match and 412 retry logic.
 * Caller supplies transport-specific copy/head callbacks (AWS SDK, etc.).
 */
export async function copyObjectToTrashWithDestinationGuard(
  sourceKey: string,
  initialTrashKey: string,
  sourceEtag: string,
  attemptCopy: (destinationKey: string) => Promise<void>,
  headDestination: (destinationKey: string) => Promise<TrashDestinationHead>,
  sourceLastModified?: Date,
  maxAttempts = 10,
): Promise<TrashCopyAttemptResult> {
  let destinationKey = initialTrashKey

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await attemptCopy(destinationKey)
      return { trashKey: destinationKey }
    }
    catch (error) {
      if (!isPreconditionFailedError(error))
        throw error

      const destinationStat = await headDestination(destinationKey)
      if (destinationStat === 'not_found')
        return 'skipped_changed'
      if (trashDestinationMatchesSource(destinationStat, sourceEtag, sourceLastModified))
        return { trashKey: destinationKey }
      destinationKey = getUniqueR2TrashKey(sourceKey)
    }
  }

  throw new Error(`Failed to copy ${sourceKey} to trash after ${maxAttempts} attempts`)
}

export async function resolveAvailableR2TrashKey(
  s3client: Pick<RawS3LiteClient, 'statObject' | 'makeRequest'>,
  key: string,
  sourceEtag?: string,
  sourceLastModified?: Date,
): Promise<string> {
  return resolveTrashDestinationKey({
    keyExists: async (trashKey) => {
      try {
        await s3client.statObject(trashKey)
        return true
      }
      catch (error) {
        if (isObjectNotFoundError(error))
          return false
        throw error
      }
    },
    getEtag: async (trashKey) => {
      const stat = await s3client.statObject(trashKey)
      return stat.etag
    },
    getSourceVersionMarker: async (trashKey) => {
      if (s3client.makeRequest) {
        const response = await s3client.makeRequest({
          method: 'HEAD',
          objectName: trashKey,
          returnBody: true,
        })
        return response.headers.get(`x-amz-meta-${R2_TRASH_SOURCE_LM_METADATA_KEY}`) ?? undefined
      }
      return undefined
    },
  }, key, sourceEtag, sourceLastModified)
}

export function isLiveR2Key(key: string): boolean {
  return !key.startsWith(R2_TRASH_PREFIX)
}

/** Per-segment encoding for clients that pass sourceKey into x-amz-copy-source without encoding. */
export function encodeS3LiteCopySourceKey(key: string): string {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export type S3LiteMakeRequest = (options: {
  method: string
  objectName: string
  headers?: Headers
  bucketName?: string
  query?: string | Record<string, string>
  statusCode?: number
  payload?: Uint8Array | string
  returnBody?: boolean
}) => Promise<Response>

export type S3LiteCopySource = {
  sourceKey: string
  sourceIfMatch?: string
  sourceBucketName?: string
}

export type S3LiteTrashClient = {
  copyObject: (options: S3LiteCopySource, destinationKey: string) => Promise<unknown>
  deleteObject: (key: string, options?: { ifMatch?: string, lastModified?: Date }) => Promise<unknown>
  statObject: (key: string) => Promise<{ etag: string, lastModified?: Date }>
}

export type RawS3LiteClient = {
  copyObject: S3LiteTrashClient['copyObject']
  deleteObject: (key: string) => Promise<unknown>
  statObject: S3LiteTrashClient['statObject']
  listObjects?: (options: { prefix: string }) => AsyncIterable<{ key: string }>
  /** s3_lite_client public API — required for R2 conditional deletes. */
  makeRequest?: S3LiteMakeRequest
}

export type ConditionalDeleteResult = 'deleted' | 'skipped_changed' | 'skipped_missing'

/** Permanent delete with live stat + R2 conditional delete (used by ops scripts). */
export async function permanentDeleteSourceIfMatch(
  s3client: Pick<RawS3LiteClient, 'statObject' | 'deleteObject' | 'makeRequest'>,
  key: string,
  discoveryEtag?: string,
  discoveryLastModified?: Date,
): Promise<ConditionalDeleteResult> {
  if (!discoveryEtag || !discoveryLastModified)
    return 'skipped_changed'

  let sourceEtag: string | undefined
  let sourceLastModified: Date | undefined
  try {
    const stat = await s3client.statObject(key)
    sourceEtag = stat.etag
    sourceLastModified = stat.lastModified
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'skipped_missing'
    throw error
  }

  if (!sourceEtag || !sourceLastModified)
    return 'skipped_changed'

  if (!normalizedS3EtagsMatch(discoveryEtag, sourceEtag))
    return 'skipped_changed'

  if (sourceLastModified.getTime() !== discoveryLastModified.getTime())
    return 'skipped_changed'

  return conditionalDeleteSource(s3client, key, sourceEtag, sourceLastModified)
}

/**
 * Conditional delete via s3_lite makeRequest when available.
 * R2 DeleteObject honors x-amz-if-match-last-modified-time, not standard If-Match.
 * Without makeRequest or lastModified, retain the source — stat-then-delete races with concurrent writers.
 */
export async function conditionalDeleteSource(
  s3client: Pick<RawS3LiteClient, 'deleteObject' | 'makeRequest'>,
  key: string,
  expectedEtag: string | undefined,
  sourceLastModified?: Date,
): Promise<ConditionalDeleteResult> {
  if (!expectedEtag || !sourceLastModified)
    return 'skipped_changed'

  if (!s3client.makeRequest)
    return 'skipped_changed'

  const headers = new Headers()
  for (const [key, value] of Object.entries(buildR2ConditionalDeleteHeaders({ etag: expectedEtag, lastModified: sourceLastModified })))
    headers.set(key, value)

  try {
    await s3client.makeRequest({
      method: 'DELETE',
      objectName: key,
      headers,
      statusCode: 204,
    })
    return 'deleted'
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'skipped_missing'
    if (isPreconditionFailedError(error))
      return 'skipped_changed'
    throw error
  }
}

/** Wrap s3_lite_client for trash moves. Listing stays on the raw client. */
export function asS3LiteTrashClient(s3client: RawS3LiteClient): S3LiteTrashClient & Pick<RawS3LiteClient, 'listObjects'> {
  return {
    copyObject: (options, destinationKey) => s3client.copyObject(options, destinationKey),
    statObject: key => s3client.statObject(key),
    deleteObject: async (key, options) => {
      if (options?.ifMatch !== undefined) {
        const result = await conditionalDeleteSource(s3client, key, options.ifMatch, options.lastModified)
        if (result === 'skipped_changed')
          throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }
        return
      }
      await s3client.deleteObject(key)
    },
    listObjects: s3client.listObjects
      ? s3client.listObjects.bind(s3client)
      : undefined,
  }
}

export type S3LiteTrashMoveResult = 'moved' | 'skipped_missing' | 'skipped_changed'

async function headTrashDestinationSourceMarker(
  s3client: Pick<RawS3LiteClient, 'makeRequest'>,
  destinationKey: string,
): Promise<string | undefined> {
  if (!s3client.makeRequest)
    return undefined
  const response = await s3client.makeRequest({
    method: 'HEAD',
    objectName: destinationKey,
    returnBody: true,
  })
  return response.headers.get(`x-amz-meta-${R2_TRASH_SOURCE_LM_METADATA_KEY}`) ?? undefined
}

/** Copy a live object to a destination key with CopySourceIfMatch (guards against source races). */
export async function copyS3LiteObjectIfMatch(
  s3client: Pick<RawS3LiteClient, 'makeRequest' | 'statObject'>,
  sourceKey: string,
  destinationKey: string,
  sourceIfMatch: string,
  sourceBucketName: string,
  sourceLastModified?: Date,
): Promise<void> {
  if (!sourceBucketName)
    throw new Error('sourceBucketName is required for guarded copy')
  if (!s3client.makeRequest)
    throw new Error(`Guarded copy requires makeRequest for ${sourceKey}`)

  const copySource = `${sourceBucketName}/${encodeS3LiteCopySourceKey(sourceKey)}`
  const headers = new Headers({
    'x-amz-copy-source': copySource,
    'x-amz-copy-source-if-match': quoteS3CopySourceIfMatchEtag(sourceIfMatch),
    'cf-copy-destination-if-none-match': '*',
  })
  try {
    await s3client.makeRequest({
      method: 'PUT',
      objectName: destinationKey,
      headers,
      statusCode: 200,
      returnBody: true,
    })
  }
  catch (error) {
    if (!isPreconditionFailedError(error) || !s3client.statObject)
      throw error
    try {
      const destinationStat = await s3client.statObject(destinationKey)
      if (guardedCopyDestinationMatchesSource(destinationStat, sourceIfMatch, sourceLastModified))
        return
    }
    catch (statError) {
      if (isObjectNotFoundError(statError))
        throw error
      throw statError
    }
    throw new Error(`Destination ${destinationKey} already exists with different content`)
  }
}

/** Copy a live object into trash with CopySourceIfMatch when makeRequest is available. */
export async function copyLiveObjectToTrash(
  s3client: Pick<RawS3LiteClient, 'copyObject' | 'makeRequest' | 'statObject'>,
  sourceKey: string,
  trashKey: string,
  sourceIfMatch: string,
  sourceBucketName: string,
  sourceLastModified?: Date,
  maxAttempts = 10,
): Promise<string> {
  if (!sourceBucketName)
    throw new Error('sourceBucketName is required for trash copy')
  if (!s3client.makeRequest)
    throw new Error(`Guarded trash copy requires makeRequest for ${sourceKey}`)

  const encodedSourceKey = encodeS3LiteCopySourceKey(sourceKey)
  const copySource = `${sourceBucketName}/${encodedSourceKey}`
  let destinationKey = trashKey
  const sourcePreserve = sourceLastModified
    ? await headS3LiteObjectCopyPreserve(s3client, sourceKey)
    : undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const headers = new Headers({
      'x-amz-copy-source': copySource,
      'x-amz-copy-source-if-match': quoteS3CopySourceIfMatchEtag(sourceIfMatch),
      'cf-copy-destination-if-none-match': '*',
    })
    if (sourceLastModified)
      applyR2TrashCopyMetadataHeaders(headers, sourceLastModified, sourcePreserve)
    try {
      await s3client.makeRequest!({
        method: 'PUT',
        objectName: destinationKey,
        headers,
        statusCode: 200,
        returnBody: true,
      })
      return destinationKey
    }
    catch (error) {
      if (!isPreconditionFailedError(error))
        throw error
      try {
        const destinationStat = await s3client.statObject(destinationKey)
        if (trashDestinationMatchesSource(
          { etag: destinationStat.etag, sourceVersionMarker: await headTrashDestinationSourceMarker(s3client, destinationKey) },
          sourceIfMatch,
          sourceLastModified,
        ))
          return destinationKey
        destinationKey = getUniqueR2TrashKey(sourceKey)
        continue
      }
      catch (statError) {
        if (isObjectNotFoundError(statError))
          throw { name: 'SourceChangedBeforeTrashCopy', code: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }
        throw statError
      }
    }
  }

  throw new Error(`Failed to copy ${sourceKey} to trash after ${maxAttempts} attempts`)
}

/** Move a live object to 7-day trash via s3_lite_client (encodes copy source path segments). */
export async function moveS3LiteObjectToTrash(
  s3client: RawS3LiteClient,
  key: string,
  sourceBucketName: string,
  discoveryEtag?: string,
  discoveryLastModified?: Date,
): Promise<S3LiteTrashMoveResult> {
  if (!isLiveR2Key(key))
    return 'moved'

  let sourceEtag: string | undefined
  let sourceLastModified: Date | undefined
  try {
    const stat = await s3client.statObject(key)
    sourceEtag = stat.etag
    sourceLastModified = stat.lastModified
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'skipped_missing'
    throw error
  }

  if (!sourceEtag || !sourceLastModified)
    return 'skipped_changed'

  if (discoveryEtag && !normalizedS3EtagsMatch(discoveryEtag, sourceEtag))
    return 'skipped_changed'

  if (discoveryLastModified && sourceLastModified.getTime() !== discoveryLastModified.getTime())
    return 'skipped_changed'

  const trashKey = await resolveAvailableR2TrashKey(s3client, key, sourceEtag, sourceLastModified)

  try {
    await copyLiveObjectToTrash(s3client, key, trashKey, sourceEtag, sourceBucketName, sourceLastModified)
  }
  catch (error) {
    if (isPreconditionFailedError(error) || (error as { name?: string }).name === 'SourceChangedBeforeTrashCopy')
      return 'skipped_changed'
    if (isObjectNotFoundError(error))
      return 'skipped_missing'
    throw error
  }

  let afterCopyEtag: string | undefined
  let afterCopyLastModified: Date | undefined
  try {
    const afterCopy = await s3client.statObject(key)
    afterCopyEtag = afterCopy.etag
    afterCopyLastModified = afterCopy.lastModified
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return 'moved'
    throw error
  }

  if (sourceEtag && afterCopyEtag !== sourceEtag)
    return 'skipped_changed'

  if (afterCopyLastModified && afterCopyLastModified.getTime() !== sourceLastModified.getTime())
    return 'skipped_changed'

  const deleteResult = await conditionalDeleteSource(
    s3client,
    key,
    afterCopyEtag ?? sourceEtag,
    sourceLastModified,
  )
  if (deleteResult === 'skipped_changed')
    return 'skipped_changed'
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
    code?: string
    status?: number
    statusCode?: number
    $metadata?: { httpStatusCode?: number }
  }

  if (err.$metadata?.httpStatusCode === 412 || err.status === 412 || err.statusCode === 412)
    return true

  return [err.name, err.Code, err.code].some(code => code === 'PreconditionFailed')
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

  const permissionDenied = [err.name, err.Code, err.code].some(code =>
    code === 'AccessDenied'
    || code === 'Forbidden'
    || code === 'Unauthorized',
  )
  if (permissionDenied)
    return false

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
