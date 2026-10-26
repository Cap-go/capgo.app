import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { decodeJwt } from 'jose'
import { z } from 'zod'
import { CONSOLE_RPCS, CONSOLE_TABLES } from '../utils/console_query_allowlist.ts'
import { parseBody, quickError, useCors } from '../utils/hono.ts'
import { getClaimsFromJWT, middlewareAuth } from '../utils/hono_jwt.ts'
import { supabaseClient } from '../utils/supabase.ts'
import { runConsoleQuery } from './console_query_run.ts'
import { getStorageAllowedOrigins, normalizeImagePath } from '../utils/storage.ts'
import { getEnv } from '../utils/utils.ts'
import { app as consoleAuthProxy } from './console_auth_proxy.ts'

// The console records PostgREST builder calls and runs them here as the caller's
// Postgres role, so the browser never talks to Supabase for table or RPC data.
// Only these builder methods are accepted; grants and RLS still decide record access.
const operations = z.enum(['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'overlaps', 'not', 'or', 'filter', 'match', 'order', 'limit', 'range', 'single', 'maybeSingle', 'throwOnError'])
const querySchema = z.object({
  kind: z.enum(['table', 'rpc']),
  name: z.string().min(1).max(100),
  args: z.array(z.unknown()).max(2),
  operations: z.array(z.object({ method: operations, args: z.array(z.unknown()).max(3) })).max(64),
})
// Same ceiling the storage bucket applied before uploads went through the API.
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const imagePathSchema = z.string().min(1).max(1024).refine(path => path.split('/').every(segment => segment !== '.' && segment !== '..'))

/** A bearer user session (role authenticated with a subject); the anon or service key never qualifies. */
export function isUserSessionToken(authorization: string): boolean {
  if (!authorization.startsWith('Bearer '))
    return false
  try {
    const claims = decodeJwt(authorization.slice(7))
    return claims.role === 'authenticated' && typeof claims.sub === 'string' && claims.sub.length > 0
  }
  catch {
    return false
  }
}

export const app = new Hono<MiddlewareKeyVariables>()
app.use('*', useCors)
app.route('/auth', consoleAuthProxy)

app.post('/query', async (c) => {
  const parsed = querySchema.safeParse(await parseBody(c))
  if (!parsed.success)
    return quickError(400, 'invalid_query', 'Invalid console query')
  const request = parsed.data
  if (!(request.kind === 'table' ? CONSOLE_TABLES : CONSOLE_RPCS).has(request.name))
    return quickError(403, 'unsupported_query', 'Unsupported console query')

  const authorization = c.req.header('authorization')
  if (authorization) {
    // Reject a token that is not even a user session before asking auth to verify it.
    if (!isUserSessionToken(authorization))
      return quickError(401, 'invalid_jwt', 'Invalid JWT')
  }
  else if (!(request.kind === 'rpc' && request.name === 'is_not_deleted')) {
    // Only the pre-login deleted-account probe may run as anon.
    return quickError(401, 'not_authenticated', 'Not authenticated')
  }

  // Verify the signature before any claim is written into a Postgres GUC.
  // A forged token still answers in the PostgREST body so the console sees data: null.
  if (authorization) {
    const claims = await getClaimsFromJWT(c, authorization)
    if (!claims?.sub || claims.role !== 'authenticated') {
      return c.json({ data: null, error: { message: 'Invalid JWT', code: 'PGRST301', details: null }, count: null, status: 401 })
    }
    return c.json(await runConsoleQuery(c, request, { role: 'authenticated', claims }))
  }
  return c.json(await runConsoleQuery(c, request, { role: 'anon' }))
})

app.post('/images/upload', middlewareAuth, async (c) => {
  const parsedPath = imagePathSchema.safeParse(c.req.header('x-image-path'))
  if (!parsedPath.success)
    return quickError(400, 'invalid_path', 'Invalid image path')
  const path = parsedPath.data
  // Refuse declared oversize uploads before buffering; the byte check below covers undeclared ones.
  if (Number(c.req.header('content-length') ?? 0) > MAX_IMAGE_BYTES)
    return quickError(413, 'image_too_large', 'Image must be smaller than 50 MB')
  const file = await c.req.arrayBuffer()
  // Same ceiling the storage bucket applied before uploads went through the API.
  if (file.byteLength > MAX_IMAGE_BYTES)
    return quickError(413, 'image_too_large', 'Image must be smaller than 50 MB')
  const client = supabaseClient(c, c.get('authorization')!)
  const result = await client.storage.from('images').upload(path, file, {
    contentType: c.req.header('content-type') ?? 'application/octet-stream',
    upsert: c.req.header('x-image-upsert') === 'true',
  })
  return c.json(result)
})

app.post('/images/sign', middlewareAuth, async (c) => {
  const body = z.object({ path: imagePathSchema, expiresIn: z.number().int().min(1).max(604800) }).safeParse(await parseBody(c))
  if (!body.success)
    return quickError(400, 'invalid_body', 'Invalid image request')
  // Legacy values are full storage URLs. Only this server knows the storage origin,
  // so it extracts the key here and refuses storage-shaped URLs from any other host.
  let path = body.data.path
  if (path.includes('://')) {
    const key = imagePathSchema.safeParse(normalizeImagePath(path, { allowedOrigins: getStorageAllowedOrigins(c) }))
    if (!key.success)
      return quickError(400, 'invalid_path', 'Image URL is not from Capgo storage')
    path = key.data
  }
  const result = await supabaseClient(c, c.get('authorization')!).storage.from('images').createSignedUrl(path, body.data.expiresIn)
  if (result.error || !result.data)
    return c.json(result)
  const token = new URL(result.data.signedUrl).searchParams.get('token')
  if (!token)
    return quickError(502, 'image_sign_failed', 'Unable to sign image')
  // Serve the image through this API so the browser never loads Supabase storage directly.
  const signedUrl = new URL(c.req.url)
  signedUrl.pathname = signedUrl.pathname.replace(/\/images\/sign\/?$/, '/images/read')
  signedUrl.search = ''
  signedUrl.searchParams.set('path', path)
  signedUrl.searchParams.set('token', token)
  return c.json({ ...result, data: { signedUrl: signedUrl.href } })
})

// The signed capability was issued with the caller's RLS; image elements do not send bearer headers.
app.get('/images/read', async (c) => {
  const query = z.object({ path: imagePathSchema, token: z.string().min(1).max(4096) }).safeParse(c.req.query())
  if (!query.success)
    return quickError(400, 'invalid_image', 'Invalid image request')
  const path = query.data.path.split('/').map(encodeURIComponent).join('/')
  const upstream = new URL(`/storage/v1/object/sign/images/${path}`, getEnv(c, 'SUPABASE_URL'))
  upstream.searchParams.set('token', query.data.token)
  // Workers supports manual redirects; reject non-2xx responses without following them.
  const response = await fetch(upstream, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  if (!response.ok) {
    let status = 403
    if (response.status >= 500)
      status = 502
    else if (response.status === 404)
      status = 404
    return quickError(status, 'image_unavailable', 'Image is unavailable')
  }
  return new Response(response.body as unknown as ReadableStream, {
    headers: {
      'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox; default-src \'none\'',
    },
  })
})

app.post('/images/remove', middlewareAuth, async (c) => {
  const body = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(20) }).safeParse(await parseBody(c))
  if (!body.success)
    return quickError(400, 'invalid_body', 'Invalid image request')
  const result = await supabaseClient(c, c.get('authorization')!).storage.from('images').remove(body.data.paths)
  return c.json(result)
})

// Server-sent CLI activity for one organization, replacing the Supabase realtime
// websocket. Backed by the ConsoleEvents durable object on Cloudflare only.
app.get('/events', middlewareAuth, async (c) => {
  const orgId = z.uuid().safeParse(c.req.query('org_id'))
  if (!orgId.success)
    return quickError(400, 'invalid_org', 'Invalid organization')
  const auth = c.get('auth')
  if (!auth?.claims?.sub || auth.claims.role !== 'authenticated')
    return quickError(401, 'invalid_jwt', 'Invalid JWT')
  const visible = await runConsoleQuery(c, {
    kind: 'table',
    name: 'orgs',
    args: [],
    operations: [{ method: 'select', args: ['id'] }, { method: 'eq', args: ['id', orgId.data] }, { method: 'maybeSingle', args: [] }],
  }, { role: 'authenticated', claims: auth.claims })
  if (visible.error || !visible.data)
    return quickError(403, 'not_authorized', 'Not authorized')
  const events = (c.env as { CONSOLE_EVENTS?: DurableObjectNamespace } | undefined)?.CONSOLE_EVENTS
  if (!events)
    return quickError(503, 'events_unavailable', 'Console events are unavailable')
  const response = await events.get(events.idFromName(orgId.data)).fetch('https://console-events/subscribe')
  return new Response(response.body as unknown as ReadableStream, { headers: Array.from(response.headers.entries()), status: response.status })
})
