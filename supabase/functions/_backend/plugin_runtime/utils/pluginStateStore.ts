import type { KVNamespace, R2Bucket, R2ObjectBody } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStatePointer } from './pluginStateFormat.ts'
import { pluginStateImmutableKey } from './pluginStateFormat.ts'
import { PluginStateMiss } from './pluginStateRegistry.ts'
import { parsePluginStatePointer } from './pluginStateValidation.ts'

export const R2_POINTER_TIMEOUT_MS = 50

interface PluginStateReadMetrics {
  r2_pointer_reads: number
  r2_pointer_ms: number
  r2_pointer_timeouts: number
  kv_value_reads: number
  kv_value_ms: number
}

const readMetrics = new WeakMap<Request, PluginStateReadMetrics>()

/** Allocate provider counters only for requests selected by the timing sample. */
export function startPluginStateReadMetrics(c: Context): PluginStateReadMetrics {
  const metrics = { r2_pointer_reads: 0, r2_pointer_ms: 0, r2_pointer_timeouts: 0, kv_value_reads: 0, kv_value_ms: 0 }
  readMetrics.set(c.req.raw, metrics)
  return metrics
}

/** Bound pointer headers and body decoding; a late object is discarded, never read from KV. */
async function readPointer(pointers: R2Bucket, logicalKey: string, metrics: PluginStateReadMetrics | undefined): Promise<PluginStatePointer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let current: R2ObjectBody | null = null
  const startedAt = metrics ? performance.now() : 0
  if (metrics)
    metrics.r2_pointer_reads++
  const discard = (object: R2ObjectBody | null) => { void object?.body?.cancel().catch(() => undefined) }
  try {
    return await Promise.race([
      pointers.get(logicalKey).then(async (object) => {
        current = object
        if (timedOut) {
          discard(object)
          return null
        }
        return object ? parsePluginStatePointer(await object.json<unknown>()) : null
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          if (metrics)
            metrics.r2_pointer_timeouts++
          discard(current)
          reject(new PluginStateMiss('publication index timed out'))
        }, R2_POINTER_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
    if (metrics)
      metrics.r2_pointer_ms += performance.now() - startedAt
  }
}

/** Strongly consistent publication index; only immutable values live in KV. */
export async function readPublishedPluginState(c: Context, store: KVNamespace, logicalKey: string): Promise<{ value: unknown, revision: string | null }> {
  const pointers = (c.env as { PLUGIN_STATE_POINTERS?: R2Bucket } | undefined)?.PLUGIN_STATE_POINTERS
  if (!pointers)
    throw new PluginStateMiss('publication index unavailable')
  const metrics = readMetrics.get(c.req.raw)
  const pointer = await readPointer(pointers, logicalKey, metrics)
  if (!pointer)
    return { value: null, revision: null }
  if (pointer.kvKey === null)
    return { value: null, revision: pointer.generation }
  if (pointer.kvKey !== await pluginStateImmutableKey(logicalKey, pointer.generation))
    throw new PluginStateMiss('publication pointer identity mismatch')
  const startedAt = metrics ? performance.now() : 0
  if (metrics)
    metrics.kv_value_reads++
  let value: unknown
  try {
    value = await store.get<unknown>(pointer.kvKey, { type: 'json', cacheTtl: 30 })
  }
  finally {
    if (metrics)
      metrics.kv_value_ms += performance.now() - startedAt
  }
  if (value === null)
    throw new PluginStateMiss('published value not propagated')
  return { value, revision: pointer.generation }
}
