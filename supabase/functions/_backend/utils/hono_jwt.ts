import type { Context } from 'hono'
import type { AuthInfo, JWTClaims } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { createClient } from '@supabase/supabase-js'
import { honoFactory, quickError, simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'
import { getEnv } from './utils.ts'

const claimsClients = new Map<string, ReturnType<typeof createClient<Database>>>()

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
    const supabaseUrl = getEnv(c, 'SUPABASE_URL').replace(/\/$/, '')
    const supabaseAnonKey = getEnv(c, 'SUPABASE_ANON_KEY')

    const authClient = getClaimsClient(supabaseUrl, supabaseAnonKey).auth
    const { data, error } = await authClient.getClaims(token)
    if (error || !data?.claims) {
      return null
    }

    return data.claims as JWTClaims
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
  if (!claims || !claims.sub) {
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
