export type R2CleanupDeleteMode = 'dry_run' | 'trash' | 'permanent'

export function resolveR2CleanupDeleteMode(env: Record<string, string | undefined>): R2CleanupDeleteMode {
  if (env.DRY_RUN !== 'false')
    return 'dry_run'
  if (env.ALLOW_PERMANENT_R2_DELETE === 'true')
    return 'permanent'
  return 'trash'
}

export const R2_TRASH_PREFIX = 'deleted-after-7-days/'

export function getR2TrashKey(sourceKey: string): string {
  if (sourceKey.startsWith(R2_TRASH_PREFIX))
    return sourceKey
  return `${R2_TRASH_PREFIX}${sourceKey}`
}
