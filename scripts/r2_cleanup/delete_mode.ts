export type R2CleanupDeleteMode = 'dry_run' | 'trash' | 'permanent'

export {
  ConcurrencyLimiter,
  encodeS3CopySource,
  getR2TrashKey,
  isLiveR2Key,
  R2_TRASH_PREFIX,
  resolveOpsDeleteMode,
} from '../r2_trash_utils.ts'

import { resolveOpsDeleteMode } from '../r2_trash_utils.ts'

export function resolveR2CleanupDeleteMode(env: Record<string, string | undefined>): R2CleanupDeleteMode {
  return resolveOpsDeleteMode(env)
}
