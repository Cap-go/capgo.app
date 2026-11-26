import type { DeploymentState } from './deployment-state.ts'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { keysForEnvironment } from './deployment-state.ts'

export type DeployTarget = 'supabase' | 'api' | 'translation' | 'files' | 'plugins' | 'gotrue'
export type DeployScope = Record<DeployTarget, boolean>
type GitRunner = (args: string[]) => string

export interface DeployScopeResult {
  base: string | null
  files: string[]
  head: string
  scope: DeployScope
}

const deployTargets = ['supabase', 'api', 'translation', 'files', 'plugins', 'gotrue'] as const satisfies readonly DeployTarget[]
const deployTargetSchema = z.enum(deployTargets)

const workerDependencyMatchers = [
  /^package\.json$/,
  /^\.npmrc$/,
  /^bunfig\.toml$/,
  /^tsconfig\.json$/,
  /^deno-env\.d\.ts$/,
]

const backendDependencyMatchers = [
  /^supabase\/functions\/deno\.(json|lock)$/,
]

const backendUtilityMatchers = [
  /^supabase\/functions\/_backend\/utils\//,
]

const mcpCatalogMatchers = [
  /^cli\/src\/mcp\/(skill-catalog\.ts|skills\.generated\.json)$/,
]

export const deployMatchers: Record<DeployTarget, RegExp[]> = {
  supabase: [
    ...backendDependencyMatchers,
    ...mcpCatalogMatchers,
    /^supabase\/config\.toml$/,
    /^supabase\/functions\//,
    /^supabase\/migrations\//,
    /^messages\/en\.json$/,
    /^supabase\/functions\/shared\/preview-subdomain\.ts$/,
    /^cloudflare_workers\/read-replica-schema-check\//,
    /^read_replicate\//,
    /^scripts\/(check-read-replica-hyperdrive-schema\.sh|sync-read-replica-schema\.ts)$/,
    /^scripts\/push-release-migrations\.sh$/,
    /^scripts\/supabase-cloud-functions\.ts$/,
  ],
  api: [
    ...workerDependencyMatchers,
    ...mcpCatalogMatchers,
    ...backendDependencyMatchers,
    ...backendUtilityMatchers,
    /^cloudflare_workers\/api\//,
    /^supabase\/functions\/_backend\/files\/util\.ts$/,
    /^supabase\/functions\/_backend\/mcp\//,
    /^supabase\/functions\/_backend\/private\//,
    /^supabase\/functions\/_backend\/public\//,
    /^supabase\/functions\/_backend\/triggers\//,
    /^messages\/en\.json$/,
  ],
  translation: [
    ...workerDependencyMatchers,
    /^cloudflare_workers\/translation\//,
    /^messages\/en\.json$/,
  ],
  files: [
    ...workerDependencyMatchers,
    ...backendDependencyMatchers,
    ...backendUtilityMatchers,
    /^cloudflare_workers\/files\//,
    /^supabase\/functions\/_backend\/files\//,
    /^supabase\/functions\/_backend\/private\/(download_link|upload_link)\.ts$/,
    /^supabase\/functions\/_backend\/public\/ok\.ts$/,
    /^supabase\/functions\/shared\/preview-subdomain\.ts$/,
  ],
  plugins: [
    ...workerDependencyMatchers,
    ...backendDependencyMatchers,
    // Isolated plugin tree only — do not match shared _backend/utils (API dual-use).
    // Deno-only shared/plugin_deno_stats_fallbacks.ts is supabase-scoped, not CF plugin.
    /^cloudflare_workers\/plugin\//,
    /^supabase\/functions\/_backend\/plugin_runtime\//,
    /^supabase\/functions\/(updates|stats|channel_self|updates_debug)\//,
  ],
  // Every rollout restarts GoTrue, so only its own folder triggers one.
  gotrue: [
    /^cloudflare_workers\/gotrue\//,
  ],
}

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function matchesDeployTarget(target: DeployTarget, files: string[]): boolean {
  return files.some(file => deployMatchers[target].some(pattern => pattern.test(file)))
}

export function resolveDeployScopeFromFiles(files: string[]): DeployScope {
  return deployTargets.reduce((scope, target) => {
    scope[target] = matchesDeployTarget(target, files)
    return scope
  }, {} as DeployScope)
}

export function hasMigrationChanges(files: string[]): boolean {
  return files.some(file => file.startsWith('supabase/migrations/'))
}

export function requiresSchemaTypesSync(result: DeployScopeResult): boolean {
  return result.base === null || hasMigrationChanges(result.files)
}

// Generated release package/version changes are not deploy-source changes.
export function getComparableDeployHead(after: string, run: GitRunner = runGit): string {
  const subject = run(['log', '-1', '--format=%s', after])
  return subject.startsWith('chore(release):') ? run(['rev-parse', `${after}^`]) : after
}

export function resolveDeployScopeFromGit(
  head: string,
  state: DeploymentState,
  run: GitRunner = runGit,
): DeployScopeResult {
  const comparableHead = getComparableDeployHead(head, run)
  const scope: DeployScope = { supabase: false, api: false, translation: false, files: false, plugins: false, gotrue: false }
  const changed = new Set<string>()
  let unknownSupabase = false
  for (const key of keysForEnvironment(state.environment)) {
    const target: DeployTarget = key.startsWith('plugins_') ? 'plugins' : deployTargetSchema.parse(key)
    const entry = state.entries[key]
    if (!entry?.success || entry.pending) {
      scope[target] = true
      if (target === 'supabase')
        unknownSupabase = true
      continue
    }
    const files = entry.success.sha === head ? [] : run(['diff', '--name-only', '--diff-filter=ACMRTD', `${entry.success.sha}..${comparableHead}`]).split('\n').filter(Boolean)
    if (matchesDeployTarget(target, files))
      scope[target] = true
    if (target === 'supabase')
      files.forEach(file => changed.add(file))
  }
  return { base: unknownSupabase ? null : state.entries.supabase?.success?.sha ?? null, files: [...changed], head, scope }
}
