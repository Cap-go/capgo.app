/** Backend read regions, not physical storage or Worker placement guarantees. */
export const SERVING_REGIONS = ['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME'] as const
export type ServingRegion = typeof SERVING_REGIONS[number]
export type ServingRegionMode = 'route' | 'block'
export interface ServingPolicy { regions: ServingRegion[], mode: ServingRegionMode }

export function isServingRegion(value: unknown): value is ServingRegion {
  return typeof value === 'string' && SERVING_REGIONS.some(region => region === value)
}

export function parseServingRegions(value: unknown): ServingRegion[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isServingRegion) || new Set(value).size !== value.length)
    throw new Error('Expected a nonempty unique list of supported serving regions')
  return value
}

export function parseServingRegionMode(value: unknown): ServingRegionMode {
  if (value !== 'route' && value !== 'block')
    throw new Error('Expected route or block')
  return value
}

/** Only truly absent legacy fields default. Explicit null/invalid values fail closed. */
export function parseServingPolicy(regions: unknown, mode: unknown): ServingPolicy {
  return {
    regions: regions === undefined ? [...SERVING_REGIONS] : parseServingRegions(regions),
    mode: mode === undefined ? 'route' : parseServingRegionMode(mode),
  }
}

export function isRestrictedServingPolicy(policy: ServingPolicy) {
  return policy.regions.length !== SERVING_REGIONS.length || policy.mode !== 'route'
}

export function servingPolicyKey(appId: string) {
  return `sr1:${appId}`
}
