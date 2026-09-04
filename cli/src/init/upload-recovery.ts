import { resolve } from 'node:path'

export const MONOREPO_ROOT_PATHS_NOTE = 'These must be the monorepo/workspace root paths — the workspace package.json and the hoisted node_modules folder — not the app package under apps/ or packages/.'

export const MONOREPO_UPLOAD_RETRY_HINT = 'If this app lives in a monorepo, retry the upload with the monorepo root package.json and the monorepo root node_modules paths (not the app package folder).'

export type BundleUploadRecoveryChoice = 'retry' | 'retry-with-monorepo-paths'

export function getBundleUploadFailureRecoveryOptions(): { value: BundleUploadRecoveryChoice, label: string, hint?: string }[] {
  return [
    { value: 'retry', label: 'Retry bundle upload' },
    {
      value: 'retry-with-monorepo-paths',
      label: 'Provide monorepo root package.json and node_modules paths, then retry',
      hint: 'Workspace root, not the app package folder',
    },
  ]
}

export function joinUniqueUploadPaths(...paths: Array<string | undefined>): string | undefined {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of paths) {
    if (!value)
      continue
    for (const part of value.split(',')) {
      const trimmed = part.trim()
      if (!trimmed || seen.has(trimmed))
        continue
      seen.add(trimmed)
      result.push(trimmed)
    }
  }
  return result.length ? result.join(',') : undefined
}

export function resolveUploadPaths(paths: string | undefined, baseDir: string): string | undefined {
  if (!paths)
    return undefined
  return joinUniqueUploadPaths(
    ...paths.split(',').map(part => part.trim()).filter(Boolean).map(part => resolve(baseDir, part)),
  )
}

export function withMonorepoUploadRetryHint(error: string): string {
  if (!error)
    return MONOREPO_UPLOAD_RETRY_HINT
  if (error.includes(MONOREPO_UPLOAD_RETRY_HINT))
    return error
  return `${error}\n${MONOREPO_UPLOAD_RETRY_HINT}`
}
