import type { SavedCredentials } from '../schemas/build'
import { quoteCredentialsExportTerminalValue } from './credentials-export-terminal'

export type CredentialsStoreName = 'local' | 'global'
export type CredentialsPlatform = 'ios' | 'android'

export interface CredentialsStoreOptions {
  appId?: string
  local?: boolean
  global?: boolean
}

export type CredentialsStores = Record<CredentialsStoreName, SavedCredentials | null>

export interface ResolvedCredentialsStore {
  source: CredentialsStoreName
  saved: SavedCredentials
}

const platforms: CredentialsPlatform[] = ['ios', 'android']
const stores: CredentialsStoreName[] = ['local', 'global']

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function credentialsPlatformFields(saved: SavedCredentials | null, platform: CredentialsPlatform): Record<string, unknown> | undefined {
  const app = record(saved)
  return app && Object.hasOwn(app, platform) ? record(app[platform]) : undefined
}

export function hasConfiguredCredentials(saved: SavedCredentials | null, platform?: CredentialsPlatform): boolean {
  const fields = platform === undefined
    ? platforms.map(item => credentialsPlatformFields(saved, item))
    : [credentialsPlatformFields(saved, platform)]
  return fields.some(field => Object.values(field ?? {}).some(value => typeof value === 'string'))
}

export function resolveCredentialsStore(options: CredentialsStoreOptions, savedStores: CredentialsStores): ResolvedCredentialsStore {
  if (options.local && options.global)
    throw new Error('Cannot use --local and --global together')

  const available = stores.filter(source => hasConfiguredCredentials(savedStores[source]))
  const source = options.local || options.global
    ? options.local ? 'local' : 'global'
    : available[0]
  const appId = quoteCredentialsExportTerminalValue(options.appId)

  if (source === undefined)
    throw new Error(`No saved Builder credentials for ${appId}`)
  const saved = savedStores[source]
  if (!hasConfiguredCredentials(saved))
    throw new Error(`No saved Builder credentials for ${appId} in the ${source} store`)
  if (!options.local && !options.global && available.length > 1)
    throw new Error('Saved Builder credentials exist in both stores; pass --local or --global')

  return { source, saved: saved! }
}
