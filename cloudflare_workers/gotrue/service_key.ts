import { timingSafeEqual } from 'hono/utils/buffer'

// Our service key (sb_secret_...) is not a JWT, so GoTrue would refuse it. Like
// Supabase's gateway in front of hosted Auth, this Worker swaps it for a short-lived
// service_role token. It is signed with GoTrue's own signing key (the P-256 JWK
// marked "sign" in GOTRUE_JWT_KEYS): once that key is set, GoTrue accepts ES256 only.
const TOKEN_TTL_SECONDS = 60
const BEARER = /^Bearer (\S+)$/i

export interface ServiceKeyEnv {
  SUPABASE_SERVICE_ROLE_KEY?: unknown
  GOTRUE_JWT_KEYS?: unknown
  GOTRUE_JWT_ISSUER?: unknown
}

interface SigningJwk extends JsonWebKey {
  kid: string
}

function signingJwk(keys: unknown): SigningJwk | undefined {
  if (typeof keys !== 'string' || !keys)
    return undefined
  try {
    const parsed: unknown = JSON.parse(keys)
    if (!Array.isArray(parsed))
      return undefined
    return parsed.find((key): key is SigningJwk => key?.kty === 'EC' && key.crv === 'P-256'
      && typeof key.d === 'string' && typeof key.kid === 'string'
      && Array.isArray(key.key_ops) && key.key_ops.includes('sign'))
  }
  catch {
    return undefined
  }
}

let cachedKey: { source: string, key: Promise<CryptoKey> } | undefined

function importSigningKey(source: string, jwk: SigningJwk): Promise<CryptoKey> {
  if (cachedKey?.source !== source) {
    const { kty, crv, x, y, d } = jwk
    const key = crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    cachedKey = { source, key }
  }
  return cachedKey.key
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeJson(value: object): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

async function serviceRoleToken(env: ServiceKeyEnv, source: string, jwk: SigningJwk): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  const issuer = typeof env.GOTRUE_JWT_ISSUER === 'string' && env.GOTRUE_JWT_ISSUER ? { iss: env.GOTRUE_JWT_ISSUER } : {}
  const input = `${encodeJson({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })}.${encodeJson({ ...issuer, role: 'service_role', iat, exp: iat + TOKEN_TTL_SECONDS })}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importSigningKey(source, jwk), new TextEncoder().encode(input))
  return `${input}.${base64Url(new Uint8Array(signature))}`
}

export async function swapServiceKey(request: Request, env: ServiceKeyEnv): Promise<Request> {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  const jwk = signingJwk(env.GOTRUE_JWT_KEYS)
  if (typeof serviceKey !== 'string' || !serviceKey || !jwk)
    return request

  const apikey = request.headers.get('apikey')
  const bearer = BEARER.exec(request.headers.get('authorization') ?? '')?.[1]
  const apikeyMatches = apikey !== null && await timingSafeEqual(apikey, serviceKey)
  const bearerMatches = bearer !== undefined && await timingSafeEqual(bearer, serviceKey)
  if (!apikeyMatches && !bearerMatches)
    return request

  const headers = new Headers(request.headers)
  if (apikeyMatches)
    headers.delete('apikey')
  // As Supabase's gateway does, a user session sent next to the key keeps its own role.
  if (bearerMatches || !request.headers.has('authorization'))
    headers.set('authorization', `Bearer ${await serviceRoleToken(env, env.GOTRUE_JWT_KEYS as string, jwk)}`)
  return new Request(request, { headers })
}
