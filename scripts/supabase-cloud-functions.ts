import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Capgo cloud (prod/preprod/alpha) Supabase Edge Functions that must stay
 * published on sb.capgo.app.
 *
 * Forever:
 * - `triggers` — Postgres pg_net → /functions/v1/triggers/queue_consumer/sync
 *
 * Deprecated for legacy Capgo CLIs that still call supabase.functions.invoke
 * on sb.capgo.app. Keep Capgo-cloud publish until 2026-10-28; new CLI uses
 * api.capgo.app / files.capgo.app. Capgo cloud console uses VITE_API_HOST.
 * Self-host / local consoles keep supabase.functions.invoke → /functions/v1.
 * - `bundle`, `channel`, `files`, `private`
 *
 * Capgo cloud deploy deletes every other local function name (skip-list).
 * Self-hosted installs still deploy every function under supabase/functions/.
 */
export const CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION_UNTIL = '2026-10-28'

export const CAPGO_CLOUD_SUPABASE_FUNCTIONS_FOREVER = [
  'triggers',
] as const

export const CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION = [
  'bundle',
  'channel',
  'files',
  'private',
] as const

export const CAPGO_CLOUD_SUPABASE_FUNCTIONS = [
  ...CAPGO_CLOUD_SUPABASE_FUNCTIONS_FOREVER,
  ...CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION,
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
  if (mode === 'delete-args') {
    console.log(listCapgoCloudSkippedSupabaseFunctions().join(' '))
    process.exit(0)
  }
  console.error(`Unknown mode: ${mode}. Use deploy-args | list | skip-list | delete-args`)
  process.exit(1)
}
