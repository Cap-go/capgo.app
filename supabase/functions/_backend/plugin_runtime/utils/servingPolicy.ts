import type { R2Bucket } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { ServingPolicy, ServingRegion } from './servingRegions.ts'
import { servingRegionReaderEpoch } from './servingRegionRollout.js'
import { quickError } from './hono.ts'
import { trustedIngressRegion } from './servingRegionIngress.ts'
import { compareServingRegions, isRestrictedServingPolicy, parseServingPolicy, servingPolicyKey } from './servingRegions.ts'
import { servingPolicyStatusBaseUrl } from './servingPolicyGateway.ts'
import { getEnv } from './utils.ts'

export interface ServingPolicyDocument { f: 1, app_id: string, generation: string, policy: ServingPolicy }
const policies = new WeakMap<Request, { appId: string, policy: ServingPolicy }>()
const ingressHeader = 'x-capgo-serving-ingress'
// snippet/index.js bounds active routing by MAX_SUBREQUESTS * TIMEOUT_MS,
// including policy transit, complete cache operations, and all worker attempts.
const ingressReceiptLifetimeMs = 5 * 3000

export function requestServingPolicy(c: Context) {
  return policies.get(c.req.raw)?.policy
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
    const targets: unknown = c.env?.PLUGIN_REGION_TARGETS ?? getEnv(c, 'PLUGIN_REGION_TARGETS')
    if (typeof targets !== 'string' || !targets)
      throw new Error('Serving policy gateway is not configured')
    const url = new URL(encodeURIComponent(appId), servingPolicyStatusBaseUrl(targets))
    const response = await fetch(url, {
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(1000),
    })
    if (!response.ok)
      throw new Error('Serving policy store unavailable')
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || !('active' in value) || value.active !== true
      || !('epoch' in value) || value.epoch !== servingRegionReaderEpoch)
      throw new Error('Serving policy gateway is not active for this release')
    return parseServingPolicyDocument(value, appId)
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
  const value: unknown = c.env?.SERVING_REGION_SIGNING_KEY ?? getEnv(c, 'SERVING_REGION_SIGNING_KEY')
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

function ingressBindingIp(c: Context) {
  const ip = c.req.header('cf-connecting-ip')
  if (!ip)
    throw new Error('Trusted ingress IP unavailable')
  // Cross-zone Worker requests share this address, so it cannot bind a receipt.
  const address = ip.includes(':') ? new URL(`http://[${ip}]`).hostname : ip
  if (address === '[2a06:98c0:3600::103]')
    throw new Error('Trusted ingress IP unavailable')
  return ip
}

/** The snippet receives an opaque receipt; it never receives or embeds a credential. */
export async function signServingIngress(c: Context, appId: string) {
  const region = trustedIngressRegion(c.req.raw.cf?.colo)
  if (!region)
    throw new Error('Trusted ingress colo unavailable')
  const ip = ingressBindingIp(c)
  const payload = JSON.stringify({ appId, region, ip, expires: Date.now() + ingressReceiptLifetimeMs })
  const signature = hex(await crypto.subtle.sign('HMAC', await signingKey(c), new TextEncoder().encode(payload)))
  return `${encodeURIComponent(payload)}.${signature}`
}

async function ingressRegion(c: Context, appId: string): Promise<ServingRegion | undefined> {
  const receipt = c.req.header(ingressHeader)
  if (!receipt)
    return trustedIngressRegion(c.req.raw.cf?.colo)
  const ip = ingressBindingIp(c)
  const separator = receipt.lastIndexOf('.')
  const parts = [receipt.slice(0, separator), receipt.slice(separator + 1)]
  if (separator <= 0 || !/^[0-9a-f]{64}$/.test(parts[1]))
    throw new Error('Invalid ingress receipt')
  const payload = decodeURIComponent(parts[0])
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(parts[1].slice(index * 2, index * 2 + 2), 16))
  if (!await crypto.subtle.verify('HMAC', await signingKey(c), bytes, new TextEncoder().encode(payload)))
    throw new Error('Invalid ingress signature')
  const data: unknown = JSON.parse(payload)
  const now = Date.now()
  if (!data || typeof data !== 'object' || !('appId' in data) || data.appId !== appId
    || !('expires' in data) || typeof data.expires !== 'number' || !Number.isFinite(data.expires) || data.expires < now || data.expires > now + ingressReceiptLifetimeMs
    || !('ip' in data) || data.ip !== ip
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
  const admitted = policies.get(c.req.raw)
  if (admitted) {
    if (admitted.appId !== appId)
      throw quickError(503, 'serving_policy_unavailable', 'Serving policy app identity mismatch')
    return
  }
  let policy: ServingPolicy
  try {
    policy = (await readServingPolicy(c, appId)).policy
    if (isRestrictedServingPolicy(policy)) {
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
  policies.set(c.req.raw, { appId, policy })
  if (isRestrictedServingPolicy(policy))
    c.header('X-Serving-Regions', policy.regions.join(','))
}

/** Stable policy partition: tightened settings cannot reuse entries filled from disabled replicas. */
export function servingCachePartition(c: Context) {
  const policy = requestServingPolicy(c)
  return policy && isRestrictedServingPolicy(policy) ? [...policy.regions].sort(compareServingRegions).join(',') : null
}
