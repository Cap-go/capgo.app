import type { R2Bucket } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { ServingPolicy, ServingRegion } from './servingRegions.ts'
import { servingRegionReaderEpoch } from './servingRegionRollout.js'
import { quickError } from './hono.ts'
import { trustedIngressRegion } from './servingRegionIngress.ts'
import { isRestrictedServingPolicy, parseServingPolicy, servingPolicyKey } from './servingRegions.ts'

export interface ServingPolicyDocument { f: 1, app_id: string, generation: string, policy: ServingPolicy }
const policies = new WeakMap<Request, ServingPolicy>()
const ingressHeader = 'x-capgo-serving-ingress'

export function requestServingPolicy(c: Context) {
  return policies.get(c.req.raw)
}

export function parseServingPolicyDocument(value: unknown, appId: string): ServingPolicyDocument {
  if (!value || typeof value !== 'object' || !('f' in value) || value.f !== 1
    || !('app_id' in value) || value.app_id !== appId
    || !('generation' in value) || typeof value.generation !== 'string' || !/^[1-9]\d{0,18}$/.test(value.generation)
    || !('policy' in value) || !value.policy || typeof value.policy !== 'object'
    || !('regions' in value.policy) || !('mode' in value.policy))
    throw new Error('Invalid serving policy document')
  return { f: 1, app_id: appId, generation: value.generation, policy: parseServingPolicy(value.policy.regions, value.policy.mode) }
}

/** No Cache API/KV fallback: every request must see the current policy before app data. */
export async function readServingPolicy(c: Context, appId: string): Promise<ServingPolicyDocument> {
  const bucket: R2Bucket | undefined = c.env?.PLUGIN_STATE_POINTERS
  if (!bucket) {
    // Deno shares the gate but has no R2 binding. Fetch only control metadata,
    // never app data or a primary database. No caller-selected origin.
    const response = await fetch(`https://plugin.eu.capgo.app/serving_policy/${encodeURIComponent(appId)}`, {
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(1000),
    })
    if (!response.ok)
      throw new Error('Serving policy store unavailable')
    return parseServingPolicyDocument(await response.json(), appId)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const object = await bucket.get(servingPolicyKey(appId))
        if (!object)
          throw new Error('Serving policy not initialized')
        return parseServingPolicyDocument(await object.json(), appId)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Serving policy timeout')), 100)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

function signingSecret(c: Context): string | undefined {
  const value: unknown = c.env?.SERVING_REGION_SIGNING_KEY
  return typeof value === 'string' && value.length >= 32 ? value : undefined
}

async function signingKey(c: Context) {
  const secret = signingSecret(c)
  if (!secret)
    throw new Error('Serving ingress signing is not configured')
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The snippet receives an opaque receipt; it never receives or embeds a credential. */
export async function signServingIngress(c: Context, appId: string) {
  const region = trustedIngressRegion(c.req.raw.cf?.colo)
  if (!region)
    throw new Error('Trusted ingress colo unavailable')
  const ip = c.req.header('cf-connecting-ip')
  if (!ip)
    throw new Error('Trusted ingress IP unavailable')
  const payload = JSON.stringify({ appId, region, ip, expires: Date.now() + 5000 })
  const signature = hex(await crypto.subtle.sign('HMAC', await signingKey(c), new TextEncoder().encode(payload)))
  return `${encodeURIComponent(payload)}.${signature}`
}

async function ingressRegion(c: Context, appId: string): Promise<ServingRegion | undefined> {
  const receipt = c.req.header(ingressHeader)
  if (!receipt)
    return trustedIngressRegion(c.req.raw.cf?.colo)
  const separator = receipt.lastIndexOf('.')
  const parts = [receipt.slice(0, separator), receipt.slice(separator + 1)]
  if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[1]))
    throw new Error('Invalid ingress receipt')
  const payload = decodeURIComponent(parts[0])
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(parts[1].slice(index * 2, index * 2 + 2), 16))
  if (!await crypto.subtle.verify('HMAC', await signingKey(c), bytes, new TextEncoder().encode(payload)))
    throw new Error('Invalid ingress signature')
  const data: unknown = JSON.parse(payload)
  if (!data || typeof data !== 'object' || !('appId' in data) || data.appId !== appId
    || !('expires' in data) || typeof data.expires !== 'number' || data.expires < Date.now() || data.expires > Date.now() + 5000
    || !('ip' in data) || data.ip !== c.req.header('cf-connecting-ip')
    || !('region' in data))
    throw new Error('Expired or mismatched ingress receipt')
  return parseServingPolicy([data.region], 'block').regions[0]
}

export async function enforceServingPolicy(c: Context, appId: string) {
  // An immutable deployment artifact, never a request header/envclient or KV miss.
  // Disabled releases retain the exact legacy data/cache path without control I/O.
  if (!servingRegionReaderEpoch)
    return
  // Shared handlers can call the gate twice without a second store read.
  if (policies.has(c.req.raw))
    return
  let policy: ServingPolicy
  try {
    policy = (await readServingPolicy(c, appId)).policy
    if (policy.mode === 'block') {
      const ingress = await ingressRegion(c, appId)
      if (!ingress)
        throw new Error('Trusted ingress unavailable')
      if (!policy.regions.includes(ingress))
        throw quickError(403, 'serving_region_blocked', 'Requests from this region are blocked')
    }
  }
  catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 403)
      throw error
    throw quickError(503, 'serving_policy_unavailable', 'Regional serving policy temporarily unavailable')
  }
  policies.set(c.req.raw, policy)
  if (isRestrictedServingPolicy(policy))
    c.header('X-Serving-Regions', policy.regions.join(','))
}

/** Stable policy partition: tightened settings cannot reuse entries filled from disabled replicas. */
export function servingCachePartition(c: Context) {
  const policy = requestServingPolicy(c)
  return policy && isRestrictedServingPolicy(policy) ? [...policy.regions].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).join(',') : null
}

export { ingressHeader as SERVING_INGRESS_HEADER }
