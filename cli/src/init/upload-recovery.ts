import { resolve } from 'node:path'
import { shellQuotePath } from '../app/info'
import { formatRunnerCommand } from '../runner-command'

export const MONOREPO_ROOT_PATHS_NOTE = 'Use the Capacitor app package.json, not the workspace manifest. Dependencies resolve from app-local and hoisted node_modules automatically; provide explicit paths only to override discovery.'

export const MONOREPO_UPLOAD_RETRY_HINT = 'If this app lives in a monorepo, verify the selected app directory and its package.json before installing dependencies. Hoisted node_modules are discovered automatically.'

export type BundleUploadRecoveryChoice = 'retry' | 'retry-with-monorepo-paths'

export function getBundleUploadFailureRecoveryOptions(): { value: BundleUploadRecoveryChoice, label: string, hint?: string }[] {
  return [
    { value: 'retry', label: 'Retry bundle upload' },
    {
      value: 'retry-with-monorepo-paths',
      label: 'Provide app package.json and dependency paths, then retry',
      hint: 'App manifest; app-local or hoisted node_modules',
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


export function mergeMonorepoRootUploadPaths(
  prompted: { packageJson?: string, nodeModules?: string },
  current: { packageJson?: string, nodeModules?: string },
  promptCwd: string,
): { packageJson?: string, nodeModules?: string } {
  return {
    packageJson: joinUniqueUploadPaths(
      resolveUploadPaths(prompted.packageJson, promptCwd),
      resolveUploadPaths(current.packageJson, promptCwd),
    ),
    nodeModules: joinUniqueUploadPaths(
      resolveUploadPaths(prompted.nodeModules, promptCwd),
      resolveUploadPaths(current.nodeModules, promptCwd),
    ),
  }
}

export function formatBundleUploadRunnerCommand(
  runner: string,
  appId: string,
  options: {
    bundle?: string
    channel?: string
    deltaOnly?: boolean
    packageJson?: string
    nodeModules?: string
  },
): string {
  const args: string[] = ['@capgo/cli@latest', 'bundle', 'upload', appId]
  if (options.bundle)
    args.push('--bundle', options.bundle)
  if (options.channel)
    args.push('--channel', options.channel)
  if (options.deltaOnly)
    args.push('--delta-only')
  if (options.packageJson)
    args.push('--package-json', shellQuotePath(options.packageJson))
  if (options.nodeModules)
    args.push('--node-modules', shellQuotePath(options.nodeModules))
  return formatRunnerCommand(runner, args)
}

export function withMonorepoUploadRetryHint(error: string): string {
  if (!error)
    return MONOREPO_UPLOAD_RETRY_HINT
  if (error.includes(MONOREPO_UPLOAD_RETRY_HINT))
    return error
  return `${error}\n${MONOREPO_UPLOAD_RETRY_HINT}`
}
