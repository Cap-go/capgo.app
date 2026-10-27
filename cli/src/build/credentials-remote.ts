/**
 * Server-side stored build credentials (Capgo API /build/credentials).
 *
 * `build credentials push` reads the locally saved credentials for one app/platform
 * and stores them encrypted on Capgo, so builds (CLI `--use-stored-credentials` or the
 * hosted MCP) can use them without sending secrets each time. Only key names and
 * non-secret facts are ever printed.
 */
import process, { stdin } from 'node:process'
import { confirm, isCancel, log } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { CliUserError } from '../shared/cli-user-error'
import { createCapgoClient, findSavedKey, formatError, getConfig } from '../utils'
import { getBuilderAppId } from './app-id'
import { getSavedCredentials } from './credentials'

export type RemoteCredentialsPlatform = 'ios' | 'android'
export type RemoteCredentialsMode = 'replace' | 'merge'

export interface RemoteCredentialsBaseOptions {
  apikey?: string
  apiHost?: string
  platform?: string
}

export interface PushRemoteCredentialsOptions extends RemoteCredentialsBaseOptions {
  mode?: string
  local?: boolean
  global?: boolean
}

export interface DeleteRemoteCredentialsOptions extends RemoteCredentialsBaseOptions {
  yes?: boolean
}

export interface RemoteCredentialsSummary {
  platform: RemoteCredentialsPlatform
  keys: string[]
  missing: string[]
  ios_distribution?: string
  app_store_connect_team_id?: string
  ios_upload_auth?: string
  provisioning_profiles?: Array<{ bundle_id: string, name: string, expires_at: string | null }>
  play_store_upload?: boolean
  custom_build_env_keys?: string[]
}

export interface RemoteCredentialsStatus {
  app_id: string
  platforms: Array<{ platform: RemoteCredentialsPlatform, configured: boolean, created_at?: string, updated_at?: string, summary?: RemoteCredentialsSummary }>
}

export function parseRemotePlatform(value: string | undefined, required = true): RemoteCredentialsPlatform | undefined {
  if (value === undefined || value === '') {
    if (required)
      throw new CliUserError('--platform is required (ios or android)')
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized !== 'ios' && normalized !== 'android')
    throw new CliUserError('--platform must be ios or android')
  return normalized
}

export function parseRemoteMode(value: string | undefined): RemoteCredentialsMode {
  if (value === undefined || value === '')
    return 'replace'
  if (value !== 'replace' && value !== 'merge')
    throw new CliUserError('--mode must be replace or merge')
  return value
}

/** Drops undefined/non-string values from the saved credentials before upload. */
export function toRemoteCredentialsPayload(saved: Record<string, unknown>): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value === 'string' && value !== '')
      payload[key] = value
  }
  return payload
}

async function resolveAppId(appIdArg: string | undefined): Promise<string> {
  let extConfig: Awaited<ReturnType<typeof getConfig>> | undefined
  try {
    extConfig = await getConfig(true)
  }
  catch {
    // Not in a Capacitor project: the app id must be passed explicitly.
  }
  const appId = getBuilderAppId(appIdArg, extConfig?.config, 'native')
  if (!appId)
    throw new CliUserError('App ID is required: pass it as an argument or run from a Capacitor project')
  return appId
}

async function callCredentialsApi<T>(options: RemoteCredentialsBaseOptions, method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const apikey = options.apikey || findSavedKey(true)
  const client = await createCapgoClient(apikey, options.apiHost, true)
  const response = await fetch(`${client.apiHost}${path}`, {
    method,
    headers: buildCliRequestHeaders({ 'authorization': client.apikey, 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  }
  catch {
    parsed = { message: text.slice(0, 500) }
  }
  if (!response.ok) {
    const error = parsed as { error?: string, message?: string }
    throw new CliUserError(`Capgo API ${response.status}${error.error ? ` ${error.error}` : ''}: ${error.message ?? 'request failed'}`)
  }
  return parsed as T
}

function logSummary(summary: RemoteCredentialsSummary | undefined) {
  if (!summary)
    return
  log.info(`Keys: ${summary.keys.join(', ') || '(none)'}`)
  if (summary.ios_distribution)
    log.info(`iOS distribution: ${summary.ios_distribution}`)
  if (summary.app_store_connect_team_id)
    log.info(`Team ID: ${summary.app_store_connect_team_id}`)
  if (summary.ios_upload_auth)
    log.info(`TestFlight upload auth: ${summary.ios_upload_auth}`)
  for (const profile of summary.provisioning_profiles ?? [])
    log.info(`Provisioning profile: ${profile.bundle_id} (${profile.name})${profile.expires_at ? `, expires ${profile.expires_at}` : ''}`)
  if (summary.play_store_upload !== undefined)
    log.info(`Play Store upload: ${summary.play_store_upload ? 'configured' : 'not configured'}`)
  if (summary.missing.length > 0) {
    log.warn('Still missing for a build with default options:')
    for (const item of summary.missing)
      log.warn(`  • ${item}`)
  }
  else {
    log.success('Ready to build with these stored credentials.')
  }
}

export async function pushRemoteCredentials(appIdArg: string | undefined, options: PushRemoteCredentialsOptions) {
  const platform = parseRemotePlatform(options.platform)!
  const mode = parseRemoteMode(options.mode)
  if (options.local && options.global)
    throw new CliUserError('Use either --local or --global, not both')
  const appId = await resolveAppId(appIdArg)
  const location = options.local ? true : options.global ? false : undefined
  const saved = await getSavedCredentials(appId, platform, location)
  const credentials = toRemoteCredentialsPayload((saved ?? {}) as Record<string, unknown>)
  if (Object.keys(credentials).length === 0) {
    throw new CliUserError(`No saved ${platform} credentials for ${appId}. Save them first: npx @capgo/cli@latest build credentials save --appId ${appId} --platform ${platform}`)
  }
  const result = await callCredentialsApi<{ summary: RemoteCredentialsSummary, updated_at: string }>(options, 'PUT', '/build/credentials', {
    app_id: appId,
    platform,
    mode,
    credentials,
  })
  log.success(`Stored ${platform} build credentials for ${appId} on Capgo (encrypted, mode: ${mode}).`)
  logSummary(result.summary)
  return result
}

export async function getRemoteCredentialsStatus(appIdArg: string | undefined, options: RemoteCredentialsBaseOptions) {
  const appId = await resolveAppId(appIdArg)
  const platformFilter = parseRemotePlatform(options.platform, false)
  const status = await callCredentialsApi<RemoteCredentialsStatus>(options, 'GET', `/build/credentials?app_id=${encodeURIComponent(appId)}`)
  for (const entry of status.platforms) {
    if (platformFilter && entry.platform !== platformFilter)
      continue
    if (!entry.configured) {
      log.info(`${entry.platform}: no stored credentials`)
      continue
    }
    log.info(`${entry.platform}: stored (updated ${entry.updated_at})`)
    logSummary(entry.summary)
  }
  return status
}

export async function deleteRemoteCredentials(appIdArg: string | undefined, options: DeleteRemoteCredentialsOptions) {
  const platform = parseRemotePlatform(options.platform)!
  const appId = await resolveAppId(appIdArg)
  if (!options.yes) {
    if (!stdin.isTTY)
      throw new CliUserError('Refusing to delete without confirmation in non-interactive mode; pass --yes')
    const confirmed = await confirm({ message: `Delete the ${platform} build credentials stored on Capgo for ${appId}?` })
    if (isCancel(confirmed) || !confirmed) {
      log.info('Cancelled.')
      return null
    }
  }
  const result = await callCredentialsApi<{ deleted: boolean }>(options, 'DELETE', '/build/credentials', { app_id: appId, platform })
  log.success(`Deleted the ${platform} build credentials stored on Capgo for ${appId}.`)
  return result
}

function runCommand<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      await fn(...args)
    }
    catch (error) {
      log.error(formatError(error))
      process.exitCode = 1
    }
  }
}

export const pushRemoteCredentialsCommand = runCommand(pushRemoteCredentials)
export const remoteCredentialsStatusCommand = runCommand(getRemoteCredentialsStatus)
export const deleteRemoteCredentialsCommand = runCommand(deleteRemoteCredentials)
