import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlogErr, serializeError } from './logging.ts'

const CACHE_METHOD = 'GET'

/** Hot-path Cache API reads must not block /updates P999 when CF Cache stalls. */
export const CACHE_MATCH_TIMEOUT_MS = 20

type CacheLike = Cache & { default?: Cache, open?: (cacheName: string) => Promise<Cache> }

const TIMEOUT = Symbol('cache-timeout')

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
      }),
    ])
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

async function resolveGlobalCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined')
    return null

  const cacheStorage = caches as any as CacheLike
  // Cloudflare Workers uses caches.default
  if (getRuntimeKey() === 'workerd' && cacheStorage.default)
    return cacheStorage.default
  // Standard CacheStorage API requires opening a named cache
  if (typeof cacheStorage.open === 'function') {
    try {
      return await cacheStorage.open('capgo-cache')
    }
    catch {
      return null
    }
  }
  return null
}

export type CacheKeyParams = Record<string, string>

export class CacheHelper {
  private cache: Cache | null = null
  private cachePromise: Promise<Cache | null>

  constructor(private context: Context) {
    this.cachePromise = resolveGlobalCache().then((cache) => {
      this.cache = cache
      return cache
    })
  }

  private async ensureCache(): Promise<Cache | null> {
    if (this.cache === null) {
      await this.cachePromise
    }
    return this.cache
  }

  get available() {
    return this.cache !== null
  }

  buildRequest(path: string, params: CacheKeyParams = {}) {
    const url = new URL(this.context.req.url)
    url.pathname = path
    url.search = ''
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value)
    })
    return new Request(url.toString(), { method: CACHE_METHOD })
  }

  /**
   * Read JSON from Cache API. On timeout or error, fail open with null so hot
   * paths (app status, manifest rows) continue via DB/cold logic instead of
   * hanging the worker wall clock.
   */
  async matchJson<T>(key: Request, options?: { timeoutMs?: number }): Promise<T | null> {
    const timeoutMs = options?.timeoutMs ?? CACHE_MATCH_TIMEOUT_MS
    const result = await withTimeout(this.matchJsonUnbound<T>(key), timeoutMs)
    if (result === TIMEOUT)
      return null
    return result
  }

  private async matchJsonUnbound<T>(key: Request): Promise<T | null> {
    try {
      const cache = await this.ensureCache()
      if (!cache)
        return null
      const cachedResponse = await cache.match(key)
      if (!cachedResponse)
        return null
      return await cachedResponse.json<T>()
    }
    catch (error) {
      this.logCacheError('Error reading cached response', error)
      return null
    }
  }

  async putJson(key: Request, payload: unknown, ttlSeconds: number) {
    const cache = await this.ensureCache()
    if (!cache)
      return
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': this.buildCacheControl(ttlSeconds),
    })
    const response = new Response(JSON.stringify(payload), { headers })
    try {
      await cache.put(key, response.clone())
    }
    catch (error) {
      this.logCacheError('Error writing cached response', error)
    }
  }

  async delete(key: Request) {
    const cache = await this.ensureCache()
    if (!cache)
      return
    try {
      await cache.delete(key)
    }
    catch (error) {
      this.logCacheError('Error deleting cached response', error)
    }
  }

  private buildCacheControl(ttlSeconds: number) {
    const sanitized = Math.max(0, Math.floor(ttlSeconds))
    return `public, s-maxage=${sanitized}`
  }

  private logCacheError(message: string, error: unknown) {
    cloudlogErr({ requestId: this.context.get('requestId'), message, error: serializeError(error) })
  }
}
