import type { Context } from 'hono'
import type { AuthInfo, JWTClaims } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { createClient } from '@supabase/supabase-js'
import { honoFactory, quickError, simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'
import { getEnv } from './utils.ts'

const claimsClients = new Map<string, ReturnType<typeof createClient<Database>>>()

// HS256 sessions make getClaims() call the auth server (getUser) on every request.
// Reuse a successful verification briefly so a console page does not pay that
// round trip per query. Failures are not cached, and a hit never outlives exp.
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

function getClaimsClient(supabaseUrl: string, supabaseAnonKey: string) {
  const cacheKey = `${supabaseUrl}|${supabaseAnonKey.substring(0, 8)}`
  const cached = claimsClients.get(cacheKey)
  if (cached) {
    return cached
  }

  const client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
  claimsClients.set(cacheKey, client)
  return client
}

/**
 * Decode JWT claims through Supabase Auth `getClaims()`.
 * Kept out of hono.ts so plugin workers do not load supabase-js.
 */
export async function getClaimsFromJWT(c: Context, jwt: string): Promise<JWTClaims | null> {
  try {
    const token = jwt.startsWith('Bearer ') ? jwt.slice(7) : jwt
    if (!token)
      return null
    const cached = readCachedClaims(token, Date.now())
    if (cached)
      return cached

    const supabaseUrl = getEnv(c, 'SUPABASE_URL').replace(/\/$/, '')
    const supabaseAnonKey = getEnv(c, 'SUPABASE_ANON_KEY')

    const authClient = getClaimsClient(supabaseUrl, supabaseAnonKey).auth
    const { data, error } = await authClient.getClaims(token)
    if (error || !data?.claims) {
      return null
    }

    const claims = data.claims as JWTClaims
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

  // Decode JWT claims via Supabase Auth `getClaims()`.
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
