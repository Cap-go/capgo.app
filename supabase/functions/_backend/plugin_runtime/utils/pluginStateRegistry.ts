import type { PluginStatePlanAction } from './pluginStateEval.ts'

/** An unavailable state dependency must retry via the replica, never look like missing data. */
export class PluginStateMiss extends Error {
  constructor(what: string) {
    super(`plugin state missing: ${what}`)
    this.name = 'PluginStateMiss'
  }
}

export function isPluginStateMiss(error: unknown): error is Error {
  // Drizzle wraps query failures in DrizzleQueryError.cause. Preserve the
  // fallback marker through that wrapper instead of returning an empty success.
  if (!(error instanceof Error))
    return false
  let current: unknown = error
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof PluginStateMiss)
      return true
    if (!(current instanceof Error) || !('cause' in current))
      return false
    current = current.cause
  }
  return false
}

/**
 * The plugin queries of pg.ts that a KV plugin state session answers
 * (pluginState.ts). A request served from the plugin state binds its session
 * to the Drizzle client it hands the endpoint code; every pg.ts query called
 * with that client is answered by the session instead of Postgres. Kept apart
 * from pluginState.ts so pg.ts can import it without an import cycle.
 */
export interface PluginStateQueries {
  readonly appId: string
  appOwner: (actions: PluginStatePlanAction[], includeTrialAt: boolean) => Promise<Record<string, unknown> | null>
  appById: (actions: PluginStatePlanAction[]) => Promise<{ owner_org: string, plan_valid: boolean } | null | undefined>
  blockProviderInfraRequests: () => Promise<{ status: 'found', blockProviderInfraRequests: boolean } | { status: 'missing' }>
  defaultChannel: (platform: string, defaultChannel: string | null | undefined, includeManifest: boolean, includeMetadata: boolean) => Promise<any>
  defaultChannelRollout: (platform: string, defaultChannel: string | null | undefined, includeMetadata: boolean) => Promise<any>
  channelById: (channelId: number, includeManifest: boolean, includeMetadata: boolean) => Promise<any>
  channelByIdRollout: (channelId: number, includeMetadata: boolean) => Promise<any>
  channelDevice: (deviceId: string, includeManifest: boolean, includeMetadata: boolean) => Promise<any>
  channelDeviceRollout: (deviceId: string, includeMetadata: boolean) => Promise<any>
  channelDeviceOverride: (deviceId: string) => Promise<{ app_id: string, device_id: string, channel_id: { id: number, allow_device_self_set: boolean, name: string } } | null>
  channelLookup: (filter: { name: string } | { id: number }) => Promise<{ id: number, name: string, allow_device_self_set: boolean, public: boolean, owner_org: string } | null>
  mainChannels: () => Promise<{ name: string, ios: boolean, android: boolean, electron: boolean }[]>
  channels: (condition: { defaultChannel?: string } | { public: boolean }) => Promise<{ id: number, name: string, ios: boolean, android: boolean, electron: boolean, public: boolean }[]>
  compatibleChannels: (platform: string, isEmulator: boolean, isProd: boolean) => Promise<any[]>
  effectiveChannelById: (channelId: number, platform: string) => Promise<{ id: number, name: string } | undefined>
  effectiveOverrideChannel: (deviceId: string) => Promise<{ id: number, name: string } | undefined>
  effectiveChannelByName: (name: string | null, platform: string) => Promise<{ id: number, name: string } | undefined>
  appVersion: (versionName: string, allowedDeleted: boolean | undefined) => Promise<{ id: number, owner_org: string } | null>
  manifestEntries: (versionId: number | string) => Promise<{ file_name: string, file_hash: string, s3_path: string }[]>
}

const bound = new WeakMap<object, PluginStateQueries>()

export function bindPluginStateQueries(client: object, queries: PluginStateQueries) {
  bound.set(client, queries)
}

/** The plugin state session answering queries sent with this client for this app, if any. */
export function pluginStateQueriesFor(client: unknown, appId?: string): PluginStateQueries | null {
  if (!client || typeof client !== 'object')
    return null
  const queries = bound.get(client)
  if (!queries)
    return null
  if (appId !== undefined && queries.appId !== appId)
    return null
  return queries
}
