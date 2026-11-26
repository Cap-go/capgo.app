import type { MiddlewareHandler } from 'hono'
import type { MiddlewareKeyVariables } from '../../supabase/functions/_backend/utils/hono.ts'
import { getEnv } from '../../supabase/functions/_backend/utils/utils.ts'

const CHINA_API_HOST = 'api.capgo.com.cn'
const DEFAULT_BUILDER_ORIGIN = 'https://api.capgo.app'
const BUILD_LOGS_DIRECT_PREFIX = '/build_logs_direct/'

const HOP_BY_HOP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

const HOP_BY_HOP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function builderLogStreamOrigin(c: Parameters<MiddlewareHandler<MiddlewareKeyVariables>>[0]) {
  const configured = getEnv(c, 'BUILDER_URL').trim()
  if (!configured)
    return DEFAULT_BUILDER_ORIGIN
  try {
    return new URL(configured).origin
  }
  catch {
    return DEFAULT_BUILDER_ORIGIN
  }
}

export const chinaBuildLogsDirectProxy: MiddlewareHandler<MiddlewareKeyVariables> = async (c, next) => {
  const url = new URL(c.req.url)
  if (url.hostname !== CHINA_API_HOST || !url.pathname.startsWith(BUILD_LOGS_DIRECT_PREFIX))
    return next()

  const upstreamUrl = new URL(`${url.pathname}${url.search}`, builderLogStreamOrigin(c))
  const headers = new Headers()
  c.req.raw.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_REQUEST.has(key.toLowerCase()))
      headers.append(key, value)
  })

  const init: RequestInit = {
    method: c.req.method,
    headers,
    redirect: 'manual',
    signal: c.req.raw.signal,
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
    init.body = c.req.raw.body

  const upstream = await fetch(upstreamUrl, init)
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel()
    return c.json({ error: 'builder_proxy_error', message: 'Unexpected builder redirect' }, 502)
  }

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_RESPONSE.has(key.toLowerCase()))
      responseHeaders.append(key, value)
  })

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
}