// index.js
// Alibaba FC HTTP Trigger with Event Function
// Proxies updater.capgo.com.cn with stale-while-revalidate cache.
// After an upstream timeout/error, serve cached JSON/files until a
// revalidate succeeds.
//
// Important: FC freezes the instance after the HTTP response is returned, so
// revalidation must finish inside this request (within CLIENT_BUDGET_MS). Do
// not wait for a full upstream timeout and then answer — Capgo clients already
// abandon around 3s.
const { Buffer } = require('node:buffer')
const crypto = require('node:crypto')
const https = require('node:https')

const TARGET_HOST = 'updater.capgo.com.cn'
const CLIENT_BUDGET_MS = 2500
const FETCH_TIMEOUT_MS = 15000
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_CACHE_BYTES = 20 * 1024 * 1024
const MAX_MEMORY_ENTRIES = 200

/** @type {Map<string, CacheEntry>} */
const memoryCache = new Map()
let memoryCacheBytes = 0
let upstreamDegraded = false

/**
 * @typedef {{
 *   statusCode: number,
 *   headers: Record<string, string | string[] | undefined>,
 *   body: string,
 *   isBase64Encoded: boolean,
 *   cachedAt: number,
 *   byteLength: number,
 * }} CacheEntry
 */

function isDegraded() {
  return upstreamDegraded
}

function setDegraded(value) {
  upstreamDegraded = value
}

function entryByteLength(entry) {
  return entry.byteLength ?? Buffer.byteLength(entry.body, entry.isBase64Encoded ? 'base64' : 'utf8')
}

/**
 * @param {string} key
 * @returns {CacheEntry | null}
 */
function getCache(key) {
  const mem = memoryCache.get(key)
  if (!mem)
    return null
  memoryCache.delete(key)
  memoryCache.set(key, mem)
  return mem
}

function trimMemoryCache() {
  while (
    memoryCache.size > MAX_MEMORY_ENTRIES
    || memoryCacheBytes > MAX_TOTAL_CACHE_BYTES
  ) {
    const oldest = memoryCache.keys().next().value
    if (oldest === undefined)
      break
    const oldestEntry = memoryCache.get(oldest)
    if (oldestEntry)
      memoryCacheBytes -= entryByteLength(oldestEntry)
    memoryCache.delete(oldest)
  }
}

/**
 * @param {string} key
 * @param {CacheEntry} entry
 */
function setCache(key, entry) {
  if (entry.byteLength > MAX_ENTRY_BYTES) {
    console.log('[CACHE] skip oversized entry', { key: key.slice(0, 120), bodyBytes: entry.byteLength })
    return
  }

  const previous = memoryCache.get(key)
  if (previous)
    memoryCacheBytes -= entryByteLength(previous)

  memoryCache.set(key, entry)
  memoryCacheBytes += entry.byteLength
  trimMemoryCache()
}

/**
 * @param {string} method
 * @param {string} reqPath
 * @param {Buffer | null} bodyBuffer
 */
function makeCacheKey(method, reqPath, bodyBuffer) {
  const bodyHash = bodyBuffer?.length
    ? crypto.createHash('sha256').update(bodyBuffer).digest('hex')
    : ''
  return `${method.toUpperCase()} ${reqPath} ${bodyHash}`
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 */
function sanitizeResponseHeaders(headers) {
  const skip = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'set-cookie',
  ])
  /** @type {Record<string, string | string[] | undefined>} */
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (!skip.has(k.toLowerCase()))
      out[k] = v
  }
  out['access-control-allow-origin'] = '*'
  return out
}

/**
 * @param {CacheEntry} entry
 * @param {'HIT' | 'STALE'} cacheState
 */
function respondFromCache(entry, cacheState) {
  return {
    statusCode: entry.statusCode,
    headers: {
      ...sanitizeResponseHeaders(entry.headers),
      'x-aliproxy-cache': cacheState,
      'x-aliproxy-cached-at': String(entry.cachedAt),
    },
    body: entry.body,
    isBase64Encoded: entry.isBase64Encoded,
  }
}

/**
 * @param {import('https').RequestOptions} options
 * @param {Buffer | null} bodyBuffer
 * @param {number} timeoutMs
 */
function fetchUpstream(options, bodyBuffer, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const fail = (err, timeout = false) => {
      if (settled)
        return
      settled = true
      resolve({ ok: false, error: err, timeout })
    }

    const req = https.request({ ...options, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('error', err => fail(err, false))
      res.on('end', () => {
        if (settled)
          return
        settled = true
        resolve({
          ok: true,
          statusCode: res.statusCode || 502,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
    })

    req.on('timeout', () => {
      req.destroy()
      fail(new Error(`upstream timeout after ${timeoutMs}ms`), true)
    })
    req.on('error', err => fail(err, false))

    if (bodyBuffer)
      req.write(bodyBuffer)
    req.end()
  })
}

function isUpstreamUsable(result) {
  return result.ok && result.statusCode < 500
}

/**
 * @param {{ statusCode: number, headers: any, body: Buffer }} upstream
 */
function buildProxyResponse(upstream) {
  const encoding = upstream.headers['content-encoding']
  const isCompressed = encoding === 'gzip' || encoding === 'deflate' || encoding === 'br' || encoding === 'zstd'
  const isTextResponse = !isCompressed && /^(?:text\/|application\/(?:json|javascript|xml))/.test(
    upstream.headers['content-type'] || '',
  )
  const body = isTextResponse ? upstream.body.toString('utf8') : upstream.body.toString('base64')
  const isBase64Encoded = !isTextResponse

  return {
    statusCode: upstream.statusCode,
    headers: {
      ...sanitizeResponseHeaders(upstream.headers),
      'x-aliproxy-cache': 'MISS',
    },
    body,
    isBase64Encoded,
  }
}

/**
 * @param {string} key
 * @param {ReturnType<typeof buildProxyResponse>} response
 * @param {any} upstreamHeaders
 */
function maybeCacheResponse(key, response, upstreamHeaders) {
  if (response.statusCode < 200 || response.statusCode >= 300)
    return

  setCache(key, {
    statusCode: response.statusCode,
    headers: sanitizeResponseHeaders(upstreamHeaders),
    body: response.body,
    isBase64Encoded: response.isBase64Encoded,
    cachedAt: Date.now(),
    byteLength: Buffer.byteLength(response.body, response.isBase64Encoded ? 'base64' : 'utf8'),
  })
}

function parseRequestData(event) {
  if (Buffer.isBuffer(event))
    return JSON.parse(event.toString('utf8'))
  if (typeof event === 'string')
    return JSON.parse(event)
  return event
}

function buildUpstreamRequest(requestData) {
  const method = requestData.requestContext?.http?.method || requestData.httpMethod || 'POST'
  const reqPath = requestData.rawPath || requestData.path || '/'
  const headers = requestData.headers || {}
  const bodyString = requestData.body || ''

  const proxyHeaders = { ...headers, host: TARGET_HOST }
  if (!proxyHeaders['user-agent'])
    proxyHeaders['user-agent'] = 'CapgoAlibabaProxy/1.0'

  let bodyBuffer = null
  if (bodyString) {
    bodyBuffer = requestData.isBase64Encoded
      ? Buffer.from(bodyString, 'base64')
      : Buffer.from(bodyString, 'utf8')
    proxyHeaders['content-length'] = bodyBuffer.length
  }

  return {
    method,
    reqPath,
    bodyBuffer,
    options: {
      hostname: TARGET_HOST,
      port: 443,
      path: reqPath,
      method,
      headers: proxyHeaders,
    },
  }
}

function storeFreshUpstream(cacheKey, result) {
  const response = buildProxyResponse(result)
  maybeCacheResponse(cacheKey, response, result.headers)
  setDegraded(false)
  return response
}

function upstreamErrorResponse() {
  return {
    statusCode: 502,
    headers: {
      'content-type': 'text/plain',
      'x-aliproxy-cache': 'MISS',
      'x-aliproxy-degraded': '1',
    },
    body: 'upstream error',
  }
}

async function handleRequest(event) {
  const requestData = parseRequestData(event)
  const { method, reqPath, bodyBuffer, options } = buildUpstreamRequest(requestData)
  const cacheKey = makeCacheKey(method, reqPath, bodyBuffer)
  const cached = getCache(cacheKey)
  const degraded = isDegraded()

  console.log('[DEBUG] Proxying request:', {
    url: `https://${TARGET_HOST}${reqPath}`,
    method,
    hasBody: !!bodyBuffer,
    bodySize: bodyBuffer ? bodyBuffer.length : 0,
    degraded,
    hasCache: !!cached,
  })

  // With cache (healthy or degraded): revalidate in-request within client budget,
  // then fall back to stale. Never depend on work after the response is sent.
  const waitMs = cached ? CLIENT_BUDGET_MS : FETCH_TIMEOUT_MS
  const result = await fetchUpstream(options, bodyBuffer, waitMs)

  if (isUpstreamUsable(result)) {
    const response = storeFreshUpstream(cacheKey, result)
    console.log('[DEBUG] Response:', {
      statusCode: response.statusCode,
      contentType: result.headers['content-type'],
      bodySize: result.body.length,
      cache: 'MISS',
    })
    return response
  }

  const failureReason = result.ok
    ? `upstream status ${result.statusCode}`
    : result.error.message
  console.error('[ERROR] Request failed:', failureReason, { timeout: !result.ok && result.timeout })
  setDegraded(true)

  if (cached) {
    console.log('[DEBUG] Serving STALE within client budget')
    return respondFromCache(cached, 'STALE')
  }

  return upstreamErrorResponse()
}

exports.handler = function (event, _context, callback) {
  handleRequest(event)
    .then(result => callback(null, result))
    .catch((err) => {
      console.error('[ERROR] Handler exception:', err)
      callback(null, {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'internal error',
      })
    })
}
