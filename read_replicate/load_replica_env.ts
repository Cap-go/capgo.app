import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { encodePostgresUrlPasswordIfNeeded } from './postgres_connection_config.ts'
import { normalizeGoogleReplicaDatabaseUrl } from './google_replica_connection.ts'

export const READ_REPLICA_DATABASE_ENV_KEYS = [
  'READ_REPLICATE_GOOGLE_EU1',
  'READ_REPLICA_DB_URL',
  'READ_REPLICATE_DB_URL',
  'GOOGLE_READ_REPLICA_DB_URL',
] as const

const moduleDir = dirname(fileURLToPath(import.meta.url))

/** KEY=VALUE lines without shell or Bun `$` expansion (values stay literal). */
export function parseReplicaEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const withoutExport = trimmed.replace(/^export\s+/u, '')
    const equals = withoutExport.indexOf('=')
    if (equals <= 0)
      continue
    const key = withoutExport.slice(0, equals).trim()
    let value = withoutExport.slice(equals + 1).trim()
    const quoted = /^(['"])(.*)\1$/su.exec(value)
    if (quoted)
      value = quoted[2]!
    else if (/\s+#/.test(value))
      value = value.replace(/\s+#.*$/u, '').trim()
    values[key] = value
  }
  return values
}

export { encodePostgresUrlPasswordIfNeeded } from './postgres_connection_config.ts'

export function resolveGitRepoRoot(): string | undefined {
  let dir = resolve(moduleDir, '..')
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, '.git')))
      return dir
    const parent = dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }
  return undefined
}

export function defaultReadReplicaEnvFilePath(): string {
  const fromGit = resolveGitRepoRoot()
  if (fromGit)
    return join(fromGit, 'internal/cloudflare/.env.prod')
  return resolve(moduleDir, '../internal/cloudflare/.env.prod')
}

function replicaDatabaseKeysUnset(): boolean {
  return READ_REPLICA_DATABASE_ENV_KEYS.every(key => !process.env[key]?.trim())
}

export interface ReadReplicaEnvLoadResult {
  loadedFrom: string | null
  appliedKeys: string[]
}

export function ensureReadReplicaEnvLoaded(): ReadReplicaEnvLoadResult {
  if (!replicaDatabaseKeysUnset())
    return { loadedFrom: null, appliedKeys: [] }

  const envFile = (
    process.env.READ_REPLICA_ENV_FILE?.trim()
    || defaultReadReplicaEnvFilePath()
  )

  if (!existsSync(envFile)) {
    throw new Error(
      `Read-replica database URL is unset and env file not found: ${envFile}. `
      + `Set READ_REPLICATE_GOOGLE_EU1, READ_REPLICA_DB_URL, READ_REPLICATE_DB_URL, or GOOGLE_READ_REPLICA_DB_URL, `
      + `or point READ_REPLICA_ENV_FILE at a file that defines one.`,
    )
  }

  const parsed = parseReplicaEnvFile(readFileSync(envFile, 'utf8'))
  const appliedKeys: string[] = []
  for (const key of READ_REPLICA_DATABASE_ENV_KEYS) {
    if (process.env[key]?.trim())
      continue
    const raw = parsed[key]
    if (!raw)
      continue
    process.env[key] = finalizeReplicaDatabaseUrl(raw)
    appliedKeys.push(key)
  }

  if (!READ_REPLICA_DATABASE_ENV_KEYS.some(key => process.env[key]?.trim())) {
    throw new Error(
      `Read-replica env file ${envFile} does not define `
      + `${READ_REPLICA_DATABASE_ENV_KEYS.join(', ')}.`,
    )
  }

  console.error(`Loaded read-replica environment from ${envFile}`)
  return { loadedFrom: envFile, appliedKeys }
}

function finalizeReplicaDatabaseUrl(url: string): string {
  return normalizeGoogleReplicaDatabaseUrl(encodePostgresUrlPasswordIfNeeded(url))
}

export function assertReadReplicaSubscriberUrlConfigured(context: string): void {
  if (readReplicaDatabaseUrlFromEnv())
    return

  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(
      `Missing GitHub Actions secret READ_REPLICATE_GOOGLE_EU1 (${context}). `
      + 'Add the direct Google Cloud SQL eu-2 subscriber PostgreSQL URL as a repository secret before merge. '
      + 'GOOGLE_SERVICE_ACCOUNT only authenticates gcloud for Cloud SQL import and execute-sql; '
      + 'it does not provide the libpq URL required to read the live subscriber schema catalog.',
    )
  }

  throw new Error(
    `Read-replica subscriber URL is not configured (${context}). `
    + 'Set READ_REPLICATE_GOOGLE_EU1, READ_REPLICA_DB_URL, READ_REPLICATE_DB_URL, or GOOGLE_READ_REPLICA_DB_URL, '
    + 'or point READ_REPLICA_ENV_FILE at internal/cloudflare/.env.prod.',
  )
}

export function readReplicaDatabaseUrlFromEnv(): string | undefined {
  for (const key of READ_REPLICA_DATABASE_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value)
      return finalizeReplicaDatabaseUrl(value)
  }
  return undefined
}