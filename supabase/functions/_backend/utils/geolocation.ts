import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { existInEnv, getEnv } from './utils.ts'

// Antartica and Tor are redirected to EU in our snippet
type ContinentsCFWorker = 'EU' | 'NA' | 'AS' | 'OC' | 'SA' | 'AF' | 'ME' | 'HK' | 'JP'
type RegionsAWS = 'EU' | 'NA' | 'SA' | 'AF' | 'AP' | 'ME' | 'IL' | 'CA' | 'MX'
type DbRegionSB = 'EU' | 'NA' | 'AS_JAPAN' | 'AS_INDIA' | 'SA' | 'OC' | 'HK' | 'ME' | 'AF' | undefined

export function getContinentCF(c: Context): ContinentsCFWorker | undefined {
  if (!existInEnv(c, 'ENV_NAME')) {
    return undefined
  }
  // const cfData = (c.req.raw as Request & { cf?: { continent?: string } })?.cf
  // return cfData?.continent
  // capgo_plugin-eu-prod-12.46.2
  // split on - ['capgo_plugin', 'eu', 'prod', '12.46.2']
  // 1 = 'eu'
  const nameList = getEnv(c, 'ENV_NAME')?.split('-') ?? []
  if (nameList.length < 2) {
    return undefined
  }
  const nameContinent = nameList[1].toUpperCase()
  return nameContinent as ContinentsCFWorker
}

export function getContinentSB(c: Context): RegionsAWS | undefined {
  if (!existInEnv(c, 'SB_REGION')) {
    return undefined
  }
  const sbRegion = getEnv(c, 'SB_REGION')!.split('-')[0].toUpperCase()
  return sbRegion as RegionsAWS
}

export function getClientDbRegionSB(c: Context): DbRegionSB {
  // 1. Supabase Edge Functions provide region in ENV VAR SB_REGION (e.g., eu-west-3, us-east-1, ap-southeast-1)
  // 2. Cloudflare Workers: we use the name of the worker to ensure there is no weird placement (primary deployment, 99% of traffic)
  // IMPORTANT: prefer Cloudflare worker identity (ENV_NAME) when present.
  // We have seen SB_REGION accidentally set in Cloudflare environments (e.g. to a non-AWS string like "asia-east2"),
  // which would break routing and make read-only requests fall back to DIRECT_EU.
  const continent = (getRuntimeKey() === 'workerd') ? getContinentCF(c) : getContinentSB(c)
  switch (continent) {
    case 'EU': // Europe CF, AWS
      return 'EU'
    case 'ME': // Middle East AWS
    case 'IL': // Israel AWS
      return 'ME'
    case 'AF': // Africa, CF, AWS
      return 'AF'
    case 'AS': // Asia CF
    case 'AP': // Asia Pacific AWS
      return 'AS_INDIA'
    case 'HK': // Hong Kong/China CF
      return 'HK'
    case 'JP': // Japan CF / JP worker
      return 'AS_JAPAN'
    case 'OC': // Oceania CF
      return 'OC'
    case 'NA': // North America CF, AWS
    case 'CA': // Canada AWS
    case 'MX': // Mexico AWS
      return 'NA'
    case 'SA': // South America
      return 'SA'
    default:
      return undefined
  }
}
