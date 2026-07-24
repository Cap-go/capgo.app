import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Bindings } from './cloudflare.ts'
import type { DeletePayload, InsertPayload, UpdatePayload } from './supabase.ts'
import type { Database } from './supabase.types.ts'
import { getRuntimeKey } from 'hono/adapter'
import { cors } from 'hono/cors'
import { createFactory } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { Hono } from 'hono/tiny'
import { timingSafeEqual } from 'hono/utils/buffer'
import { cloudlog } from './logging.ts'
import { onError } from './on_error.ts'
import { getEnv } from './utils.ts'

import { version as CapgoVersion } from './version.ts'

export interface JWTClaims {
  sub: string
  email?: string
  role?: string
  exp?: number
  iat?: number
  aud?: string | string[]
  iss?: string
  app_metadata?: {
    provider?: string
    [key: string]: unknown
  }
}

export interface AuthInfo {
  userId: string
  authType: 'apikey' | 'jwt'
  apikey: Database['public']['Tables']['apikeys']['Row'] | null
  jwt: string | null
  claims?: JWTClaims
}

export interface MiddlewareKeyVariables {
  Bindings: Bindings
  Variables: {
    apikey?: Database['public']['Tables']['apikeys']['Row']
    parentApikey?: Database['public']['Tables']['apikeys']['Row']
    capgkey?: string
    requestId: string
    fileId?: string
    authorization?: string
    APISecret?: string
    auth?: AuthInfo
    subkey?: Database['public']['Tables']['apikeys']['Row']
    webhookBody?: any
    oldRecord?: any
    // RBAC context variables
    rbacEnabled?: boolean
    resolvedOrgId?: string
    skipSupabaseStatsFallback?: boolean
    skipSupabaseNotificationWrites?: boolean
    queuePluginNotifications?: boolean
    skipChannelSelfPostgresFallback?: boolean
    requireReadReplica?: boolean
  }
}

const CAPGO_CONSOLE_SUBDOMAIN = 'console'

const DEFAULT_CORS_ALLOWED_ORIGINS = new Set([
  ...['capgo.app', 'preprod.capgo.app', 'development.capgo.app'].map(domain => `https://${CAPGO_CONSOLE_SUBDOMAIN}.${domain}`),
  'https://capgo.app',
  'https://preprod.capgo.app',
  'https://development.capgo.app',
])

function normalizeHttpOrigin(origin: string) {
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol))
      return ''
    return parsed.origin
  }
  catch {
    return ''
  }
}

function normalizeCustomOrigin(origin: string) {
  try {
    const parsed = new URL(origin)
    if (['http:', 'https:'].includes(parsed.protocol))
      return ''
    if (!parsed.hostname)
      return ''
    return `${parsed.protocol}//${parsed.host}`
  }
  catch {
    return ''
  }
}

function normalizeNativeOrigin(origin: string) {
  try {
    const parsed = new URL(origin)
    if (!['capacitor:', 'ionic:', 'localhost:'].includes(parsed.protocol))
      return ''
    if (parsed.hostname !== 'localhost')
      return ''
    return normalizeCustomOrigin(origin)
  }
  catch {
    return ''
  }
}

function normalizeConfiguredCorsOrigin(origin: string) {
  return normalizeHttpOrigin(origin) || normalizeCustomOrigin(origin)
}

function isLocalHttpOrigin(origin: string) {
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol))
      return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  }
  catch {
    return false
  }
}

function getConfiguredCorsAllowedOrigins(c: Context) {
  return [
    getEnv(c, 'WEBAPP_URL'),
    ...getEnv(c, 'CORS_ALLOWED_ORIGINS').split(','),
  ]
    .map(origin => normalizeConfiguredCorsOrigin(origin.trim()))
    .filter(Boolean)
}

export function getAllowedCorsOrigin(origin: string, c: Context) {
  const nativeOrigin = normalizeNativeOrigin(origin)
  if (nativeOrigin)
    return nativeOrigin

  const httpOrigin = normalizeHttpOrigin(origin)
  const configuredOrigins = getConfiguredCorsAllowedOrigins(c)

  if (httpOrigin) {
    if (isLocalHttpOrigin(origin))
      return httpOrigin

    if (DEFAULT_CORS_ALLOWED_ORIGINS.has(httpOrigin))
      return httpOrigin

    if (configuredOrigins.includes(httpOrigin))
      return httpOrigin
  }

  const customOrigin = normalizeCustomOrigin(origin)
  if (customOrigin && configuredOrigins.includes(customOrigin))
    return customOrigin

  return null
}

export const useCors = cors({
  origin: getAllowedCorsOrigin,
  allowHeaders: ['Content-Type', 'Authorization', 'X-Capgo-Spoof-Admin-Authorization', 'capgkey', 'capgo_api', 'x-api-key', 'x-limited-key-id', 'apisecret', 'apikey', 'x-client-info'],
  allowMethods: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
})

export const honoFactory = createFactory<MiddlewareKeyVariables>()

export function triggerValidator(
  table: keyof Database['public']['Tables'],
  type: 'DELETE' | 'INSERT' | 'UPDATE',
) {
  return honoFactory.createMiddleware(async (c, next) => {
    const body = await c.req.json<DeletePayload<typeof table> | InsertPayload<typeof table> | UpdatePayload<typeof table>>()

    if (body.table !== String(table)) {
      cloudlog({ requestId: c.get('requestId'), message: `Not ${String(table)}` })
      throw simpleError('table_not_match', 'Not table', { body })
    }

    if (body.type !== type) {
      cloudlog({ requestId: c.get('requestId'), message: `Not ${type}` })
      throw simpleError('type_not_match', 'Not type', { body })
    }

    // Store the validated body in context for next middleware
    if (body.type === 'DELETE' && body.old_record) {
      c.set('webhookBody', body.old_record)
    }
    else if (body.type === 'INSERT' && body.record) {
      c.set('webhookBody', body.record)
    }
    else if (body.type === 'UPDATE' && body.record) {
      c.set('webhookBody', body.record)
      c.set('oldRecord', body.old_record)
    }
    else {
      throw simpleError('invalid_payload', 'Invalid payload', { body })
    }

    await next()
  })
}

export async function getBodyOrQuery<T>(c: Context<MiddlewareKeyVariables, any, any>) {
  let body: T
  try {
    body = await c.req.json<T>()
  }
  catch {
    body = c.req.query() as unknown as T
    if (c.req.method === 'GET') {
      return body
    }
  }
  if (!body || Object.keys(body).length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot find body', query: c.req.query() })
    throw simpleError('invalid_json_parse_body', 'Invalid JSON body')
  }
  if ((body as any).device_id) {
    (body as any).device_id = (body as any).device_id.toLowerCase()
  }
  return body
}

export const middlewareAPISecret = honoFactory.createMiddleware(async (c, next) => {
  const authorizationSecret = c.req.header('apisecret')
  const API_SECRET = getEnv(c, 'API_SECRET')

  // timingSafeEqual is here to prevent a timing attack
  if (!authorizationSecret || !API_SECRET) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot find authorizationSecret or API_SECRET', query: c.req.query() })
    throw simpleError('cannot_find_authorization_secret', 'Cannot find authorization')
  }
  if (!await timingSafeEqual(authorizationSecret, API_SECRET)) {
    cloudlog({ requestId: c.get('requestId'), message: 'Invalid API secret', query: c.req.query() })
    throw simpleError('invalid_api_secret', 'Invalid API secret')
  }
  c.set('APISecret', authorizationSecret)
  await next()
})

export const BRES = { status: 'ok' }
export const API_CONTENT_SECURITY_POLICY = [
  'default-src \'none\'',
  'base-uri \'none\'',
  'form-action \'none\'',
  'frame-ancestors \'none\'',
  'object-src \'none\'',
  'script-src \'none\'',
  'style-src \'none\'',
  'img-src \'none\'',
  'connect-src \'none\'',
  'upgrade-insecure-requests',
].join('; ')

function isPreviewHost(hostname: string) {
  return /^[^.]+\.preview(?:\.[^.]+)?\.(?:capgo\.app|usecapgo\.com)$/i.test(hostname)
}

export function createHono(functionName: string, _version: string) {
  let appGlobal
  if (getRuntimeKey() === 'deno') {
    appGlobal = new Hono<MiddlewareKeyVariables>().basePath(`/${functionName}`)
  }
  else {
    appGlobal = new Hono<MiddlewareKeyVariables>()
  }

  // Plugin hot paths (/updates|/stats|/channel_self and the CF plugin worker).
  // HAR/CPU inspect showed middleware + logging dominating non-DB request cost.
  const pluginHotPath = functionName === 'plugin'
    || functionName === 'updates'
    || functionName === 'stats'
    || functionName === 'channel_self'

  appGlobal.use('*', (c, next): Promise<any> => {
    // ADD HEADER TO IDENTIFY WORKER SOURCE
    const name = `${getEnv(c, 'ENV_NAME') || functionName}-${CapgoVersion}`
    c.header('X-Worker-Source', name)
    const hostname = new URL(c.req.url).hostname
    if (!isPreviewHost(hostname))
      c.header('Content-Security-Policy', API_CONTENT_SECURITY_POLICY)
    return next()
  })

  // Skip hono's access logger on plugin hot paths — it serializes every request
  // on millions of device calls/day.
  if (!pluginHotPath)
    appGlobal.use('*', logger())
  // Use platform-specific request IDs, fallback to generated UUID.
  // Do not cloudlog inside the generator: it runs on every request (incl. cf-ray).
  appGlobal.use('*', requestId({
    generator: (c) => {
      // Cloudflare provides the Ray ID in the cf-ray header
      // Check this first as it's our primary deployment target
      const cfRay = c.req.header('cf-ray')
      if (cfRay)
        return cfRay
      // Supabase Edge Functions provide SB_EXECUTION_ID
      const sbExecutionId = getEnv(c, 'SB_EXECUTION_ID')
      if (sbExecutionId)
        return sbExecutionId
      // Fallback to crypto.randomUUID() if not on any known platform
      return crypto.randomUUID()
    },
  }))

  appGlobal.post('/ok', (c) => {
    return c.json(BRES)
  })
  appGlobal.post('/ko', (c) => {
    const defaultResponse: SimpleErrorResponse = {
      error: 'unknown_error',
      message: 'KO',
      moreInfo: {},
    }
    return c.json(defaultResponse, 500)
  })

  return appGlobal
}

export function createAllCatch(appGlobal: Hono<MiddlewareKeyVariables>, functionName: string) {
  appGlobal.all('*', useCors, (c) => {
    cloudlog({ requestId: c.get('requestId'), functionName, message: 'Not found', url: c.req.url })
    return c.json({ error: 'not_found', message: 'Not found' }, 404)
  })
  appGlobal.onError(onError(functionName))
}

export interface SimpleErrorResponse {
  error: string
  message: string
  cause?: any
  moreInfo?: any
}

export function simpleError200(c: Context, errorCode: string, message: string, moreInfo: any = {}) {
  return simpleErrorWithStatus(c, 200, errorCode, message, moreInfo)
}

export function simpleErrorWithStatus(c: Context, status: ContentfulStatusCode, errorCode: string, message: string, moreInfo: any = {}) {
  const res: SimpleErrorResponse = {
    error: errorCode,
    message,
    ...moreInfo,
  }
  cloudlog({ requestId: c.get('requestId'), message, errorCode, moreInfo })
  return c.json(res, status)
}

export interface QuickErrorOptions {
  alert?: boolean
}

export function quickError(status: number, errorCode: string, message: string, moreInfo: any = {}, cause?: any, options: QuickErrorOptions = {}): never {
  // Store error details in cause so onError can extract them
  const errorDetails = {
    error: errorCode,
    message,
    moreInfo,
    originalCause: cause,
    suppressDiscordAlert: options.alert === false,
  }
  // Throw a simple HTTPException - onError will create the response with X-Request-Id header
  throw new HTTPException(status as any, {
    message,
    cause: errorDetails,
  })
}

/**
 * Throw a 429 "too_many_requests" HTTPException.
 *
 * IMPORTANT: `moreInfo` is reflected to the client as the `moreInfo` field of
 * the 429 response body (see `onError` in `on_error.ts`). Pass curated
 * diagnostic metadata only — fields like `app_id`, `device_id`, `reason`,
 * `apikey_id`, `rateLimitResetAt`, `retryAfterSeconds`. Do NOT pass the raw
 * parsed request body: that turns the rate-limit response into a reflective
 * echo of whatever the client submitted and means any future field added to
 * the request schema (sensitive or not) silently lands in the error payload.
 */
export function simpleRateLimit(moreInfo: any = {}, cause?: any): never {
  const status = 429
  const message = 'Too many requests'
  const errorCode = 'too_many_requests'
  cloudlog({ message, errorCode, moreInfo })
  return quickError(status, errorCode, message, moreInfo, cause)
}

export function simpleError(errorCode: string, message: string, moreInfo: any = {}, cause?: any): never {
  if (errorCode === 'invalid_jwt') {
    return quickError(401, errorCode, message, moreInfo, cause)
  }
  return quickError(400, errorCode, message, moreInfo, cause)
}

export function parseBody<T>(c: Context) {
  // IMPORTANT: c.req.json() consumes the request body.
  // Supabase/CF error reporters may try to read the body later for alerts and log
  // "Body already consumed". Parsing from a clone keeps the original readable.
  return c.req.raw.clone().json<T>().catch((e) => {
    throw simpleError('invalid_json_parse_body', 'Invalid JSON body', { e })
  }).then((body) => {
    if ((body as any).device_id) {
      (body as any).device_id = (body as any).device_id.toLowerCase()
    }
    return body
  })
}
