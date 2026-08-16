import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PluginRegion } from '../utils/pluginRegionTargets.ts'
import { BRES, honoFactory, middlewareAPISecret, quickError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getConfiguredPluginRegions, PLUGIN_REGIONS } from '../utils/pluginRegionTargets.ts'

export { PLUGIN_REGIONS }

const PLUGIN_REGION_TIMEOUT_MS = 5_000

interface PluginRegionResult {
  name: PluginRegion['name']
  url: PluginRegion['url']
  status: number | null
  workerSource: string | null
  version: string | null
  error: string | null
}

interface PluginRegionDifference extends PluginRegionResult {
  expectedVersion: string | null
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown fetch error'
}

function parseWorkerVersion(workerSource: string | null, envName: string) {
  if (!workerSource)
    return null

  const prefix = `${envName}-`
  if (!workerSource.startsWith(prefix))
    return null

  return workerSource.slice(prefix.length)
}

async function fetchRegionVersion(region: PluginRegion): Promise<PluginRegionResult> {
  const timeout = AbortSignal.timeout(PLUGIN_REGION_TIMEOUT_MS)

  try {
    const response = await fetch(region.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: timeout,
    })
    const workerSource = response.headers.get('x-worker-source')
    const version = parseWorkerVersion(workerSource, region.envName)
    let error: string | null = null

    if (!response.ok)
      error = 'http_error'
    else if (!workerSource)
      error = 'missing_worker_source'
    else if (!version)
      error = 'unexpected_worker_source'

    return {
      name: region.name,
      url: region.url,
      status: response.status,
      workerSource,
      version,
      error,
    }
  }
  catch (error) {
    return {
      name: region.name,
      url: region.url,
      status: null,
      workerSource: null,
      version: null,
      error: toErrorMessage(error),
    }
  }
}

function getExpectedVersion(results: PluginRegionResult[]) {
  const counts = new Map<string, number>()

  for (const result of results) {
    if (!result.version || result.error)
      continue

    counts.set(result.version, (counts.get(result.version) ?? 0) + 1)
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])

  if (!sorted.length)
    return null

  if (sorted[0][1] === sorted[1]?.[1])
    return null

  return sorted[0][0]
}

function getDifferences(results: PluginRegionResult[], expectedVersion: string | null): PluginRegionDifference[] {
  if (!expectedVersion)
    return []

  return results
    .filter(result => !result.error && result.version !== expectedVersion)
    .map(result => ({
      ...result,
      expectedVersion,
    }))
}

async function getPluginRegionVersions(c: Context<MiddlewareKeyVariables>) {
  let configuredRegions: PluginRegion[]

  try {
    configuredRegions = getConfiguredPluginRegions(c)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Invalid plugin region version check configuration',
      error: toErrorMessage(error),
    })
    return quickError(500, 'invalid_plugin_region_targets', 'Cannot parse plugin region targets')
  }

  const regions = await Promise.all(configuredRegions.map(fetchRegionVersion))
  const expectedVersion = getExpectedVersion(regions)
  const differences = getDifferences(regions, expectedVersion)
  const unavailableRegions = regions.filter(result => !!result.error)

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Plugin region version check',
    expectedVersion,
    differences: differences.length,
    unavailableRegions: unavailableRegions.length,
    regions: regions.length,
  })

  if (!expectedVersion) {
    return c.json({
      status: 'indeterminate',
      version: null,
      regions,
    })
  }

  if (differences.length) {
    return c.json({
      status: 'mismatch',
      expectedVersion,
      differences,
      regions,
    }, 409)
  }

  if (unavailableRegions.length) {
    return c.json({
      status: 'indeterminate',
      version: expectedVersion,
      unavailableRegions,
      regions,
    })
  }

  return c.json({
    ...BRES,
    version: expectedVersion,
    regions,
  })
}

export const app = honoFactory.createApp()

app.use('*', middlewareAPISecret)
app.get('/', getPluginRegionVersions)
app.get('/versions', getPluginRegionVersions)
