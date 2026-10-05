import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Hyperdrive caches read queries by query text and parameters (default
 * max_age 60s + stale_while_revalidate 15s). An edge cache refill that hits
 * that cache right after a purge stores the pre-change rows for the whole
 * edge TTL, so refills must read the replica itself.
 *
 * Hyperdrive has no per-query switch, but it never caches a query that calls
 * a STABLE or VOLATILE function. Queries sent through a lazy client inside
 * `withFreshReads` therefore get an unused CTE calling now(); PostgreSQL does
 * not evaluate a CTE nothing references. Every other query keeps Hyperdrive's
 * cache.
 */
const freshReads = new AsyncLocalStorage<boolean>()

export function withFreshReads<T>(fn: () => Promise<T>): Promise<T> {
  return freshReads.run(true, fn)
}

export function inFreshReads() {
  return freshReads.getStore() === true
}

const FRESH_CTE = 'capgo_fresh_read AS (SELECT now())'

/** Adds the uncacheable CTE to a SELECT or WITH query; anything else is returned unchanged. */
export function bypassHyperdriveCache(text: string) {
  const body = text.trimStart()
  if (/^select\b/i.test(body))
    return `WITH ${FRESH_CTE} ${body}`
  if (/^with\s+recursive\b/i.test(body))
    return body.replace(/^with\s+recursive\b/i, `WITH RECURSIVE ${FRESH_CTE},`)
  if (/^with\b/i.test(body))
    return body.replace(/^with\b/i, `WITH ${FRESH_CTE},`)
  return text
}

/** pg `query()` arguments with the CTE added when called inside `withFreshReads`. */
export function freshQueryArgs(args: unknown[]): unknown[] {
  if (!inFreshReads())
    return args
  const [first, ...rest] = args
  if (typeof first === 'string')
    return [bypassHyperdriveCache(first), ...rest]
  // Plain query configs only; a named (prepared) statement must keep its text.
  if (first && typeof first === 'object' && Object.getPrototypeOf(first) === Object.prototype) {
    const config = first as { text?: unknown, name?: unknown }
    if (typeof config.text === 'string' && !config.name)
      return [{ ...config, text: bypassHyperdriveCache(config.text) }, ...rest]
  }
  return args
}
