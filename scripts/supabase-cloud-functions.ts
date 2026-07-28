import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Capgo cloud (prod/preprod/alpha) only publishes Supabase Edge Functions that
 * still receive traffic from Postgres (pg_net) or other non-Cloudflare callers.
 *
 * Public API, plugin, private, and files traffic runs on Cloudflare Workers.
 * Self-hosted installs keep deploying every function under supabase/functions/.
 */
export const CAPGO_CLOUD_SUPABASE_FUNCTIONS = [
  'triggers',
] as const

export type CapgoCloudSupabaseFunction = typeof CAPGO_CLOUD_SUPABASE_FUNCTIONS[number]

const SKIP_FUNCTION_DIRS = new Set([
  '_backend',
  'shared',
  'plugin_runtime',
])

export function listLocalSupabaseFunctions(functionsDir = join(process.cwd(), 'supabase', 'functions')): string[] {
  return readdirSync(functionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_FUNCTION_DIRS.has(entry.name))
    .map(entry => entry.name)
    .sort()
}

export function listCapgoCloudSkippedSupabaseFunctions(localFunctions = listLocalSupabaseFunctions()): string[] {
  const keep = new Set<string>(CAPGO_CLOUD_SUPABASE_FUNCTIONS)
  return localFunctions.filter(name => !keep.has(name))
}

export function buildCapgoCloudSupabaseDeployArgs(
  functions: readonly string[] = CAPGO_CLOUD_SUPABASE_FUNCTIONS,
): string[] {
  if (functions.length === 0)
    throw new Error('CAPGO_CLOUD_SUPABASE_FUNCTIONS must not be empty')
  return [...functions]
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'deploy-args'
  if (mode === 'list') {
    for (const name of CAPGO_CLOUD_SUPABASE_FUNCTIONS)
      console.log(name)
    process.exit(0)
  }
  if (mode === 'skip-list') {
    for (const name of listCapgoCloudSkippedSupabaseFunctions())
      console.log(name)
    process.exit(0)
  }
  if (mode === 'deploy-args') {
    console.log(buildCapgoCloudSupabaseDeployArgs().join(' '))
    process.exit(0)
  }
  console.error(`Unknown mode: ${mode}. Use deploy-args | list | skip-list`)
  process.exit(1)
}
