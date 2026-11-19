import type { Context } from 'hono'
import type { Bindings } from './cloudflare.ts'
import type { AuthInfo, JWTClaims } from './hono.ts'
import { decode, verifyWithJwks } from 'hono/jwt'
import { gotrueFetch } from './gotrue_admin.ts'
import { honoFactory, quickError, simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'
import { getEnv } from './utils.ts'

// Prod sessions are ES256 and verify locally against the cached JWKS. HS256
// sessions (the local Supabase stack) and unknown `kid`s cost a GoTrue `/user`
// round trip, so a successful verification is reused briefly to spare a
// console page that call per query. Failures are not cached, and a hit never
// outlives exp.
const CLAIMS_CACHE_TTL_MS = 30_000
const CLAIMS_CACHE_MAX = 200

interface CachedClaims {
  claims: JWTClaims
  expiresAt: number
}

const verifiedClaims = new Map<string, CachedClaims>()

function claimsCacheExpiry(claims: JWTClaims, now: number): number | null {
  const ttlAt = now + CLAIMS_CACHE_TTL_MS
  if (typeof claims.exp !== 'number')
    return ttlAt
  const expAt = claims.exp * 1000
  if (expAt <= now)
    return null
  return Math.min(ttlAt, expAt)
}

function readCachedClaims(token: string, now: number): JWTClaims | null {
  const cached = verifiedClaims.get(token)
  if (!cached)
    return null
  if (cached.expiresAt <= now) {
    verifiedClaims.delete(token)
    return null
  }
  verifiedClaims.delete(token)
  verifiedClaims.set(token, cached)
  return { ...cached.claims }
}

function storeCachedClaims(token: string, claims: JWTClaims, now: number) {
  const expiresAt = claimsCacheExpiry(claims, now)
  if (expiresAt === null)
    return
  if (verifiedClaims.size >= CLAIMS_CACHE_MAX && !verifiedClaims.has(token)) {
    const oldest = verifiedClaims.keys().next().value
    if (oldest !== undefined)
      verifiedClaims.delete(oldest)
  }
  verifiedClaims.set(token, { claims: { ...claims }, expiresAt })
}

// Same JWKS lifetime and algorithms as supabase-js getClaims().
const JWKS_TTL_MS = 10 * 60 * 1000
const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256'] as const
type Jwk = JsonWebKey & { kid?: string }

const jwksCache = new Map<string, { keys: Jwk[], fetchedAt: number }>()

function authHeaders(c: Context, bearer: string) {
  return { 'apikey': getEnv(c, 'SUPABASE_ANON_KEY'), 'Authorization': `Bearer ${bearer}`, 'X-Supabase-Api-Version': '2024-01-01' }
}

// supabase-js fetchJwk: cached keys while fresh, else refetch. null means
// "verify through /user instead"; a failed fetch throws (token rejected).
async function signingKeys(c: Context, kid: string): Promise<Jwk[] | null> {
  const cacheKey = (c.env as Partial<Bindings> | undefined)?.GOTRUE ? 'binding' : getEnv(c, 'SUPABASE_URL')
  const now = Date.now()
  const cached = jwksCache.get(cacheKey)
  if (cached && cached.fetchedAt + JWKS_TTL_MS > now && cached.keys.some(key => key.kid === kid))
    return cached.keys

  const response = await gotrueFetch(c, '.well-known/jwks.json', { headers: authHeaders(c, getEnv(c, 'SUPABASE_ANON_KEY')) })
  if (!response.ok)
    throw new Error(`JWKS fetch failed with ${response.status}`)
  const { keys } = await response.json() as { keys?: Jwk[] }
  if (!Array.isArray(keys) || keys.length === 0)
    return null
  jwksCache.set(cacheKey, { keys, fetchedAt: now })
  return keys.some(key => key.kid === kid) ? keys : null
}

// Same checks as supabase-js getClaims(): exp, then the signature locally for
// ES256/RS256 with a known kid, else GoTrue `/user` vouches for the token.
async function verifyToken(c: Context, token: string): Promise<JWTClaims | null> {
  const { header, payload: decoded } = decode(token)
  const payload = decoded as unknown as JWTClaims
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000))
    return null

  const alg = header.alg as string | undefined
  const keys = alg && !alg.startsWith('HS') && header.kid ? await signingKeys(c, header.kid) : null
  if (keys) {
    // Other algs throw here, as in getClaims(). It never checked iat, and
    // GoTrue/Worker clock skew must not 401 fresh tokens.
    await verifyWithJwks(token, { keys, allowedAlgorithms: ASYMMETRIC_ALGORITHMS, verification: { iat: false } })
    return payload
  }

  const response = await gotrueFetch(c, 'user', { headers: authHeaders(c, token) })
  return response.ok ? payload : null
}

/**
 * Verify a user JWT and return its claims, like Supabase Auth `getClaims()`.
 * Kept out of hono.ts so plugin workers do not load it.
 */
export async function getClaimsFromJWT(c: Context, jwt: string): Promise<JWTClaims | null> {
  try {
    const token = jwt.startsWith('Bearer ') ? jwt.slice(7) : jwt
    if (!token)
      return null
    const cached = readCachedClaims(token, Date.now())
    if (cached)
      return cached

    const claims = await verifyToken(c, token)
    if (!claims)
      return null
    storeCachedClaims(token, claims, Date.now())
    return { ...claims }
  }
  catch {
    return null
  }
}

export const middlewareAuth = honoFactory.createMiddleware(async (c, next) => {
  const authorization = c.req.header('authorization')
  if (!authorization) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot find authorization', query: c.req.query() })
    return quickError(401, 'no_jwt_apikey_or_subkey', 'No JWT, apikey or subkey provided')
  }
  c.set('authorization', authorization)

  // Verify the JWT and decode its claims.
  const claims = await getClaimsFromJWT(c, authorization)
  if (!claims?.sub) {
    cloudlog({ requestId: c.get('requestId'), message: 'Invalid JWT claims' })
    throw simpleError('invalid_jwt', 'Invalid JWT')
  }

  // Set auth context for RBAC
  c.set('auth', {
    userId: claims.sub,
    authType: 'jwt',
    apikey: null,
    jwt: authorization,
    claims,
  } as AuthInfo)

  await next()
})

export type { JWTClaims }
