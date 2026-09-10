export type R2CleanupDeleteMode = 'dry_run' | 'trash' | 'permanent'

export {
  applyAwsCopyDestinationIfNoneMatchMiddleware,
  applyR2ConditionalDeleteMiddleware,
  ConcurrencyLimiter,
  copyObjectToTrashWithDestinationGuard,
  createAwsTrashDestinationResolver,
  encodeS3CopySource,
  getR2TrashKey,
  getUniqueR2TrashKey,
  isAlreadyMovedToTrash,
  isLiveR2Key,
  isObjectNotFoundError,
  isPreconditionFailedError,
  normalizedS3EtagsMatch,
  quoteS3CopySourceIfMatchEtag,
  R2_TRASH_PREFIX,
  resolveOpsDeleteMode,
  resolveTrashDestinationKey,
} from '../r2_trash_utils.ts'

import { resolveOpsDeleteMode } from '../r2_trash_utils.ts'

export function resolveR2CleanupDeleteMode(env: Record<string, string | undefined>): R2CleanupDeleteMode {
  return resolveOpsDeleteMode(env)
}
