import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'

const COOLDOWN_PATH = '/private/changelog/github-anonymous-cooldown'

/** Honor GitHub's primary and secondary limits without sending private credentials to public dependencies. */
export async function fetchAnonymousGithub(c: Context, url: string, headers: Record<string, string>): Promise<Response> {
  const cache = new CacheHelper(c)
  const key = cache.buildRequest(COOLDOWN_PATH)
  const until = await cache.matchJson<number>(key, { timeoutMs: 200 })
  if (until && until > Date.now()) {
    return new Response(null, {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil((until - Date.now()) / 1000)) },
    })
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  const retryAfter = response.headers.get('retry-after')
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0'
  let limited = response.status === 429 || (response.status === 403 && (exhausted || retryAfter !== null))
  if (response.status === 403 && !limited) {
    const error = await response.clone().json().catch(() => null) as { message?: unknown } | null
    limited = typeof error?.message === 'string' && /secondary rate limit/i.test(error.message)
  }
  if (!limited)
    return response

  const reset = exhausted ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0
  let retryAt = 0
  if (retryAfter !== null)
    retryAt = /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter)
  const deadline = Math.max(Date.now() + 60_000, Number.isFinite(reset) ? reset : 0, Number.isFinite(retryAt) ? retryAt : 0)
  const ttl = Math.ceil((deadline - Date.now()) / 1000)
  // Share backoff across repositories and isolates in the serving location.
  // Success caches are checked by the caller before this gate, and remain usable.
  await cache.putJson(key, deadline, ttl, { timeoutMs: 200 })
  const limitedHeaders = new Headers(response.headers)
  limitedHeaders.set('Retry-After', String(ttl))
  return new Response(response.body, { status: 429, headers: limitedHeaders })
}
