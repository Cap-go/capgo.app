import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { CacheHelper } from './cache.ts'
import { cloudlogErr, serializeError } from './logging.ts'

const pending = new Map<string, Promise<unknown>>()

/** Share concurrent misses in an isolate; paid summaries also survive eviction and colo changes. */
export async function cachedChangelog<T>(c: Context<MiddlewareKeyVariables>, options: {
  path: string
  params: Record<string, string>
  ttl: number | ((value: T) => number)
  persistent?: boolean
  /** Skip both cache writes for results obtained from a failed upstream request. */
  shouldCache?: (value: T) => boolean
  load: () => Promise<T>
}): Promise<T> {
  const cache = new CacheHelper(c)
  const key = cache.buildRequest(options.path, options.params)
  const run = async () => {
    const hit = await cache.matchJson<T>(key, { timeoutMs: 1000 })
    if (hit !== null)
      return hit
    // Reuse the existing KV binding with a separate prefix. No plugin keys are read or changed.
    const kv = options.persistent ? c.env?.CHANNEL_SELF_STORE : undefined
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(key.url).pathname + new URL(key.url).search))
    const kvKey = `changelog:digest:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
    if (kv) {
      try {
        const shared = await kv.get<T>(kvKey, 'json')
        if (shared !== null) {
          const ttl = typeof options.ttl === 'function' ? options.ttl(shared) : options.ttl
          await cache.putJson(key, shared, ttl, { timeoutMs: 1000 })
          return shared
        }
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Changelog shared cache read failed', error: serializeError(error) })
      }
    }
    const value = await options.load()
    if (options.shouldCache && !options.shouldCache(value))
      return value
    const ttl = typeof options.ttl === 'function' ? options.ttl(value) : options.ttl
    if (kv) {
      try {
        await kv.put(kvKey, JSON.stringify(value), { expirationTtl: ttl })
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Changelog shared cache write failed', error: serializeError(error) })
      }
    }
    await cache.putJson(key, value, ttl, { timeoutMs: 1000 })
    return value
  }
  // The key determines T at each call site. Only pending work is retained in memory.
  const existing = pending.get(key.url)
  if (existing)
    return await existing as T
  const promise = run()
  pending.set(key.url, promise)
  try {
    return await promise
  }
  finally {
    pending.delete(key.url)
  }
}
