import type { OptionsBase } from '../schemas/base'
import process from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { Table } from '@sauber/table'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatCapgoCliInvokeError, getAppId, getCapgoCliHttpStatus, getConfig, invokeCapgoCliApi } from '../utils'

export interface PrewarmRegion {
  region: string
  /** HTTP status of the regional call; null when it never answered. */
  status?: number | null
  /** The call ran in the worker's placement data center (server-side cf-placement check). */
  pinned?: boolean
  placement: string | null
  revision: string | null
  cached: number
  skipped: string | null
  error: string | null
}

export interface PrewarmResponse {
  app_id: string
  regions: PrewarmRegion[]
}

/** A user-facing failure: printed here, since the CLI entry point does not repeat CliUserError messages. */
function fail(message: string, context?: ConstructorParameters<typeof CliUserError>[1]): never {
  log.error(message)
  throw new CliUserError(message, context)
}

/** One line per region: where its cache lives and what the prewarm did there. */
export function describePrewarmRegion(region: PrewarmRegion) {
  if (region.error)
    return `failed: ${region.error}`
  if (region.skipped === 'disabled')
    return 'skipped (KV reads off in this region)'
  if (region.skipped)
    return `skipped (${region.skipped})`
  const result = region.cached > 0 ? `warmed ${region.cached} document${region.cached === 1 ? '' : 's'}` : 'already warm'
  // Not confirmed in its placement data center: device requests may read another cache.
  const pinned = region.pinned ?? Boolean(region.placement?.startsWith('remote-'))
  return pinned ? result : `${result} (not confirmed in the region's pinned data center)`
}

/**
 * `app prewarm`: load the app's published plugin state into every Capgo plugin
 * region's cache now, so the next device requests are served from it.
 * Publications are also prewarmed automatically after each upload or channel change.
 */
export async function prewarmApp(appId: string | undefined, options: OptionsBase): Promise<void> {
  intro('Prewarm Capgo plugin regions')
  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    fail('Missing API key, you need to provide an API key to prewarm your app')
  const extConfig = await getConfig()
  const resolvedAppId = getAppId(appId, extConfig?.config)
  if (!resolvedAppId)
    fail('Missing argument, you need to provide an appId, or be in a capacitor project')

  const { data, error } = await invokeCapgoCliApi<PrewarmResponse>(`app/${encodeURIComponent(resolvedAppId)}/prewarm`, {
    apikey,
    method: 'POST',
    body: {},
    apiHost: options.apiHost,
  })
  if (error) {
    const status = getCapgoCliHttpStatus(error)
    if (status === 401 || status === 403)
      fail('Cannot prewarm this app. Check that your API key has app.upload_bundle permission for it.', { appId: resolvedAppId, requiredPermissionKey: 'app.upload_bundle' })
    throw new Error(`Cannot prewarm app: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
  }

  const regions = data?.regions ?? []
  if (!regions.length) {
    outro('No plugin region to prewarm for this Capgo instance')
    return
  }
  const table = new Table()
  table.headers = ['Region', 'Data center', 'Result']
  table.rows = regions.map(region => [region.region, region.placement ?? '-', describePrewarmRegion(region)])
  log.info(table.toString())
  const failed = regions.filter(region => region.error)
  if (failed.length === regions.length) {
    // Nothing was warmed: let scripts and CI see it.
    process.exitCode = 1
    outro('Prewarm failed in every region ❌')
    return
  }
  if (failed.length)
    log.warn(`${failed.length} region${failed.length === 1 ? '' : 's'} could not be prewarmed; devices there fill the cache on their first requests.`)
  outro('Done ✅')
}
