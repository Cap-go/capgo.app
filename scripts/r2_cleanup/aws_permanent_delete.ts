import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import {
  applyR2ConditionalDeleteMiddleware,
  isLiveR2Key,
  isObjectNotFoundError,
  isPreconditionFailedError,
  normalizedS3EtagsMatch,
  parseS3ListingLastModified,
} from './delete_mode.ts'

export type AwsPermanentDeleteOutcome = 'deleted' | 'skipped_missing' | 'skipped_changed' | 'failed'

type AwsS3Client = {
  send: (command: unknown) => Promise<unknown>
}

export async function permanentDeleteAwsLiveKey(
  s3: AwsS3Client,
  bucket: string,
  key: string,
  candidateEtag?: string,
  candidateLastModified?: Date | string,
): Promise<AwsPermanentDeleteOutcome> {
  if (!isLiveR2Key(key))
    return 'skipped_missing'

  const normalizedCandidateLastModified = parseS3ListingLastModified(candidateLastModified)
  if (!candidateEtag || !normalizedCandidateLastModified)
    return 'failed'

  let sourceEtag: string | undefined
  let sourceLastModified: Date | undefined
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) as {
      ETag?: string
      LastModified?: Date
    }
    sourceEtag = head.ETag
    sourceLastModified = head.LastModified
  }
  catch (headError) {
    if (isObjectNotFoundError(headError))
      return 'skipped_missing'
    return 'failed'
  }

  if (!sourceEtag || !sourceLastModified)
    return 'failed'

  if (!normalizedS3EtagsMatch(candidateEtag, sourceEtag))
    return 'skipped_changed'

  if (sourceLastModified.getTime() !== normalizedCandidateLastModified.getTime())
    return 'skipped_changed'

  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      IfMatch: sourceEtag,
    })
    applyR2ConditionalDeleteMiddleware(
      deleteCommand.middlewareStack as Parameters<typeof applyR2ConditionalDeleteMiddleware>[0],
      { etag: sourceEtag, lastModified: sourceLastModified },
    )
    await s3.send(deleteCommand)
    return 'deleted'
  }
  catch (deleteError) {
    if (isObjectNotFoundError(deleteError))
      return 'skipped_missing'
    if (isPreconditionFailedError(deleteError))
      return 'skipped_changed'
    return 'failed'
  }
}
