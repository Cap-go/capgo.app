import type { Context } from 'hono'
import { getEnv } from './utils.ts'

/**
 * Rollout switch of the KV plugin state (pluginState.ts), without its
 * readers, so the edge cache and pg.ts can consult it without an import
 * cycle. `PLUGIN_STATE_KV` = off | on | N% of devices.
 */

type AnyContext = Context<any>

/** `off` | `on` | a percentage such as `1%`, `0.5` or `25`, in basis points. */
export function parsePluginStateShareBps(value: string) {
  const raw = value.replace(/\s+/g, '').toLowerCase()
  if (raw === 'on')
    return 10_000
  if (!/^\d+(?:\.\d+)?%?$/.test(raw))
    return 0
  const percent = Number(raw.replace(/%$/, ''))
  if (!Number.isFinite(percent) || percent <= 0)
    return 0
  return Math.min(Math.round(percent * 100), 10_000)
}

/** Stable bucket 0-9999 (FNV-1a), independent of the edge cache bucket. */
export function pluginStateBucket(appId: string, deviceId: string) {
  let hash = 0x811C9DC5
  for (const char of `plugin-state:${appId}:${deviceId}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 10_000
}

/** Tests: a request served from the plugin state must never open a database connection. */
export function isPluginStateStrict(c: AnyContext) {
  return getEnv(c, 'PLUGIN_STATE_KV_STRICT').trim().toLowerCase() === 'true'
}

const servedRequests = new WeakSet<object>()

/** This request is answered from the plugin state (its edge cache reads are skipped). */
export function markPluginStateServed(c: AnyContext) {
  servedRequests.add(c.req.raw)
}

export function unmarkPluginStateServed(c: AnyContext) {
  servedRequests.delete(c.req.raw)
}

export function isPluginStateServed(c: AnyContext) {
  return servedRequests.has(c.req.raw)
}
