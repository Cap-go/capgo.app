import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import type { Pool } from 'pg'
import { permanentDeleteAwsLiveKey } from './r2_cleanup/aws_permanent_delete.ts'
import {
  applyAwsCopyDestinationIfNoneMatchMiddleware,
  applyR2ConditionalDeleteMiddleware,
  buildAwsTrashCopyPreserveFromHead,
  copyObjectToTrashWithDestinationGuard,
  createAwsTrashDestinationResolver,
  encodeS3CopySource,
  extractR2TrashSourceVersionMarker,
  isAlreadyMovedToTrash,
  isObjectNotFoundError,
  isPreconditionFailedError,
  mergeTrashCopyMetadata,
  normalizedS3EtagsMatch,
  quoteS3CopySourceIfMatchEtag,
  resolveTrashDestinationKey,
  withOrphanR2DeleteClaim,
} from './r2_trash_utils.ts'

export type OrphanAwsCandidate = {
  key: string
  etag?: string
  lastModified?: Date
}

export type OrphanAwsSourceHead = {
  etag: string
  lastModified: Date
  metadata?: Record<string, string>
  contentType?: string
  cacheControl?: string
  contentEncoding?: string
  contentDisposition?: string
  expires?: Date
}

export type OrphanAwsWorkflowContext = {
  s3: { send: (command: unknown) => Promise<unknown> }
  bucket: string
  claimPool: Pool
  trashDestinationResolver: ReturnType<typeof createAwsTrashDestinationResolver>
  objectExists: (key: string) => Promise<boolean>
  isStillOrphaned: (key: string) => Promise<boolean>
}

export type OrphanAwsProcessOutcome = 'ok' | 'skipped' | 'failed'

export async function headOrphanAwsCandidate(
  ctx: OrphanAwsWorkflowContext,
  candidate: OrphanAwsCandidate,
): Promise<{ head: OrphanAwsSourceHead } | OrphanAwsProcessOutcome> {
  const { key, etag: candidateEtag, lastModified: candidateLastModified } = candidate
  if (!candidateEtag) {
    console.warn(`Failed ${key}: missing discovery ETag; source retained`)
    return 'failed'
  }
  if (!candidateLastModified) {
    console.warn(`Failed ${key}: missing discovery Last-Modified; source retained`)
    return 'failed'
  }

  try {
    const head = await ctx.s3.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key })) as {
      ETag?: string
      LastModified?: Date
      Metadata?: Record<string, string>
      ContentType?: string
      CacheControl?: string
      ContentEncoding?: string
      ContentDisposition?: string
      Expires?: Date
    }
    if (!normalizedS3EtagsMatch(candidateEtag, head.ETag)) {
      console.warn(`Skipped ${key}: live object etag changed since discovery`)
      return 'skipped'
    }
    if (!head.LastModified || head.LastModified.getTime() !== candidateLastModified.getTime()) {
      console.warn(`Skipped ${key}: live object lastModified changed since discovery`)
      return 'skipped'
    }
    if (!head.ETag || !head.LastModified) {
      console.warn(`Failed ${key}: live object has no ETag or Last-Modified; source retained`)
      return 'failed'
    }
    return {
      head: {
        etag: head.ETag,
        lastModified: head.LastModified,
        metadata: head.Metadata,
        contentType: head.ContentType,
        cacheControl: head.CacheControl,
        contentEncoding: head.ContentEncoding,
        contentDisposition: head.ContentDisposition,
        expires: head.Expires,
      },
    }
  }
  catch (headError) {
    if (isObjectNotFoundError(headError))
      return 'skipped'
    console.error(`Failed to head ${key} before cleanup:`, headError)
    return 'failed'
  }
}

export async function permanentDeleteOrphanAwsCandidate(
  ctx: OrphanAwsWorkflowContext,
  candidate: OrphanAwsCandidate,
): Promise<OrphanAwsProcessOutcome> {
  const { key, etag: candidateEtag, lastModified: candidateLastModified } = candidate
  if (!candidateEtag) {
    console.warn(`Failed ${key}: missing discovery ETag; source retained`)
    return 'failed'
  }

  if (!(await ctx.isStillOrphaned(key))) {
    console.warn(`Skipped ${key}: app_versions row appeared since discovery`)
    return 'skipped'
  }

  const claimClient = await ctx.claimPool.connect()
  try {
    const claimResult = await withOrphanR2DeleteClaim(claimClient, key, async () => {
      const outcome = await permanentDeleteAwsLiveKey(ctx.s3, ctx.bucket, key, candidateEtag, candidateLastModified)
      switch (outcome) {
        case 'deleted':
          return 'deleted'
        case 'skipped_missing':
          return 'skipped_missing'
        case 'skipped_changed':
          return 'skipped_changed'
        case 'failed':
          return 'failed'
      }
    })
    if (claimResult === 'skipped_referenced') {
      console.warn(`Skipped ${key}: app_versions row appeared since discovery`)
      return 'skipped'
    }
    switch (claimResult) {
      case 'deleted':
        return 'ok'
      case 'skipped_missing':
        return 'skipped'
      case 'skipped_changed':
        console.warn(`Skipped ${key}: live object changed since discovery`)
        return 'skipped'
      case 'failed':
        if (!candidateLastModified)
          console.warn(`Failed ${key}: missing discovery Last-Modified; source retained`)
        else
          console.warn(`Failed ${key}: permanent delete guards failed; source retained`)
        return 'failed'
    }
  }
  finally {
    claimClient.release()
  }
}

export async function moveOrphanAwsCandidateToTrash(
  ctx: OrphanAwsWorkflowContext,
  candidate: OrphanAwsCandidate,
  sourceHead: OrphanAwsSourceHead,
): Promise<OrphanAwsProcessOutcome> {
  const { key } = candidate
  const {
    etag: sourceEtag,
    lastModified: sourceLastModified,
    metadata: sourceMetadata,
    contentType: sourceContentType,
    cacheControl: sourceCacheControl,
    contentEncoding: sourceContentEncoding,
    contentDisposition: sourceContentDisposition,
    expires: sourceExpires,
  } = sourceHead

  let trashKey: string
  try {
    trashKey = await resolveTrashDestinationKey(ctx.trashDestinationResolver, key, sourceEtag, sourceLastModified)
  }
  catch (headError) {
    console.error(`Failed to allocate trash destination for ${key}:`, headError)
    return 'failed'
  }

  if (!(await ctx.isStillOrphaned(key))) {
    console.warn(`Skipped ${key}: app_versions row appeared since discovery`)
    return 'skipped'
  }

  try {
    const copyResult = await copyObjectToTrashWithDestinationGuard(
      key,
      trashKey,
      sourceEtag,
      async (destinationKey) => {
        const copyPreserve = buildAwsTrashCopyPreserveFromHead({
          Metadata: sourceMetadata,
          ContentType: sourceContentType,
          CacheControl: sourceCacheControl,
          ContentEncoding: sourceContentEncoding,
          ContentDisposition: sourceContentDisposition,
          Expires: sourceExpires,
        })
        const copyCommand = new CopyObjectCommand({
          Bucket: ctx.bucket,
          CopySource: encodeS3CopySource(ctx.bucket, key),
          CopySourceIfMatch: quoteS3CopySourceIfMatchEtag(sourceEtag),
          Key: destinationKey,
          Metadata: mergeTrashCopyMetadata(copyPreserve.metadata, sourceLastModified),
          MetadataDirective: 'REPLACE',
          ContentType: copyPreserve.contentType,
          CacheControl: copyPreserve.cacheControl,
          ContentEncoding: copyPreserve.contentEncoding,
          ContentDisposition: copyPreserve.contentDisposition,
          Expires: copyPreserve.expires,
        })
        applyAwsCopyDestinationIfNoneMatchMiddleware(copyCommand.middlewareStack)
        await ctx.s3.send(copyCommand)
      },
      async (destinationKey) => {
        try {
          const head = await ctx.s3.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: destinationKey })) as {
            ETag?: string
            Metadata?: Record<string, string>
          }
          return {
            etag: head.ETag,
            sourceVersionMarker: extractR2TrashSourceVersionMarker(head.Metadata),
          }
        }
        catch (error) {
          if (isObjectNotFoundError(error))
            return 'not_found'
          throw error
        }
      },
      sourceLastModified,
    )
    if (copyResult === 'skipped_changed') {
      console.warn(`Skipped ${key}: live object changed before trash copy`)
      return 'skipped'
    }
    trashKey = copyResult.trashKey
  }
  catch (copyError) {
    try {
      const trashExists = await ctx.objectExists(trashKey)
      const sourceExists = await ctx.objectExists(key)
      if (isAlreadyMovedToTrash(trashExists, sourceExists) || !sourceExists)
        return 'skipped'
    }
    catch (headError) {
      console.error(`Failed to verify trash resume state for ${key}:`, headError)
      return 'failed'
    }
    console.error(`Failed to trash ${key}:`, copyError)
    return 'failed'
  }

  if (!(await ctx.isStillOrphaned(key))) {
    console.warn(`Skipped delete for ${key}: app_versions row appeared after trash copy`)
    return 'skipped'
  }

  const claimClient = await ctx.claimPool.connect()
  try {
    const claimResult = await withOrphanR2DeleteClaim(claimClient, key, async () => {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: ctx.bucket,
        Key: key,
        IfMatch: sourceEtag,
      })
      applyR2ConditionalDeleteMiddleware(deleteCommand.middlewareStack, { etag: sourceEtag, lastModified: sourceLastModified })
      await ctx.s3.send(deleteCommand)
    })
    if (claimResult === 'skipped_referenced') {
      console.warn(`Skipped delete for ${key}: app_versions row appeared after trash copy`)
      return 'skipped'
    }
    return 'ok'
  }
  catch (deleteError) {
    if (isObjectNotFoundError(deleteError))
      return 'skipped'
    if (isPreconditionFailedError(deleteError)) {
      console.warn(`Skipped delete for ${key}: live object changed after copy (possible concurrent upload)`)
      return 'skipped'
    }
    console.error(`Copied ${key} to trash but failed to delete source:`, deleteError)
    return 'failed'
  }
  finally {
    claimClient.release()
  }
}
