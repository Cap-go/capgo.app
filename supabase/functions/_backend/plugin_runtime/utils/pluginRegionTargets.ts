export interface PluginRegion {
  name: string
  envName: string
  url: string
}

function isPluginRegion(value: unknown): value is PluginRegion {
  return !!value && typeof value === 'object'
    && 'name' in value && typeof value.name === 'string'
    && 'envName' in value && typeof value.envName === 'string'
    && 'url' in value && typeof value.url === 'string' && value.url.length > 0
}

export function parsePluginRegions(rawRegions: string): [PluginRegion, ...PluginRegion[]] {
  const parsed: unknown = JSON.parse(rawRegions)
  if (!Array.isArray(parsed))
    throw new Error('Invalid plugin region targets')
  const [first, ...rest] = parsed
  if (!isPluginRegion(first) || !rest.every(isPluginRegion))
    throw new Error('Invalid plugin region targets')
  return [first, ...rest]
}
