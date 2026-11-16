import type { KVNamespace, R2Bucket, R2ObjectBody } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStatePointer } from './pluginStateFormat.ts'
import { pluginStateImmutableKey } from './pluginStateFormat.ts'
import { PluginStateMiss } from './pluginStateRegistry.ts'
import { parsePluginStatePointer } from './pluginStateValidation.ts'

export const R2_POINTER_TIMEOUT_MS = 50
export const KV_VALUE_TIMEOUT_MS = 50

type R2PointerFailure = 'none' | 'headers_timeout' | 'body_timeout' | 'headers_error' | 'body_error' | 'invalid_pointer'
type R2PointerPhase = { kind: 'headers' } | { kind: 'body' | 'validation', startedAt: number, headersMs: number }

const pointerFailureByPhase = {
  headers: 'headers_error',
  body: 'body_error',
  validation: 'invalid_pointer',
} satisfies Record<R2PointerPhase['kind'], R2PointerFailure>

interface PluginStateReadMetrics {
  r2_pointer_reads: number
  r2_pointer_ms: number
  r2_pointer_timeouts: number
  r2_pointer_headers_ms: number
  r2_pointer_body_ms: number
  r2_pointer_headers_timeouts: number
  r2_pointer_body_timeouts: number
  r2_pointer_first_failure: R2PointerFailure
  kv_value_reads: number
  kv_value_ms: number
  kv_value_timeouts: number
}

const readMetrics = new WeakMap<Request, PluginStateReadMetrics>()

/** Allocate provider counters only for requests selected by the timing sample. */
export function startPluginStateReadMetrics(c: Context): PluginStateReadMetrics {
  const metrics: PluginStateReadMetrics = {
    r2_pointer_reads: 0,
    r2_pointer_ms: 0,
    r2_pointer_timeouts: 0,
    r2_pointer_headers_ms: 0,
    r2_pointer_body_ms: 0,
    r2_pointer_headers_timeouts: 0,
    r2_pointer_body_timeouts: 0,
    r2_pointer_first_failure: 'none',
    kv_value_reads: 0,
    kv_value_ms: 0,
    kv_value_timeouts: 0,
  }
  readMetrics.set(c.req.raw, metrics)
  return metrics
}

/** Bound pointer headers and body decoding; a late object is discarded, never read from KV. */
async function readPointer(pointers: R2Bucket, logicalKey: string, metrics: PluginStateReadMetrics | undefined): Promise<PluginStatePointer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let current: R2ObjectBody | null = null
  const startedAt = metrics ? performance.now() : 0
  const observation: { phase: R2PointerPhase, failure: R2PointerFailure, finished: boolean } | undefined = metrics
    ? { phase: { kind: 'headers' }, failure: 'none', finished: false }
    : undefined
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
        if (!object)
          return null
        if (observation && !observation.finished) {
          const bodyStartedAt = performance.now()
          observation.phase = { kind: 'body', headersMs: bodyStartedAt - startedAt, startedAt: bodyStartedAt }
        }
        const pointer = await object.json<unknown>()
        if (observation?.phase.kind === 'body' && !observation.finished)
          observation.phase = { ...observation.phase, kind: 'validation' }
        return parsePluginStatePointer(pointer)
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          if (metrics) {
            metrics.r2_pointer_timeouts++
            if (observation?.phase.kind === 'headers') {
              metrics.r2_pointer_headers_timeouts++
              observation.failure = 'headers_timeout'
            }
            else if (observation) {
              metrics.r2_pointer_body_timeouts++
              observation.failure = 'body_timeout'
            }
          }
          discard(current)
          reject(new PluginStateMiss('publication index timed out'))
        }, R2_POINTER_TIMEOUT_MS)
      }),
    ])
  }
  catch (error) {
    if (observation?.failure === 'none')
      observation.failure = pointerFailureByPhase[observation.phase.kind]
    throw error
  }
  finally {
    // Freeze this operation before late headers or a late body can finish.
    if (observation)
      observation.finished = true
    clearTimeout(timer)
    if (metrics && observation) {
      const phase = observation.phase
      const endedAt = performance.now()
      metrics.r2_pointer_ms += endedAt - startedAt
      if (phase.kind === 'headers') {
        metrics.r2_pointer_headers_ms += endedAt - startedAt
      }
      else {
        metrics.r2_pointer_headers_ms += phase.headersMs
        // Body time includes JSON decoding and pointer validation.
        metrics.r2_pointer_body_ms += endedAt - phase.startedAt
      }
      if (metrics.r2_pointer_first_failure === 'none')
        metrics.r2_pointer_first_failure = observation.failure
    }
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
  if (pointer.kvKey !== await pluginStateImmutableKey(logicalKey, pointer.generation)) {
    if (metrics?.r2_pointer_first_failure === 'none')
      metrics.r2_pointer_first_failure = 'invalid_pointer'
    throw new PluginStateMiss('publication pointer identity mismatch')
  }
  const startedAt = metrics ? performance.now() : 0
  if (metrics)
    metrics.kv_value_reads++
  let value: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    value = await Promise.race([
      store.get<unknown>(pointer.kvKey, { type: 'json', cacheTtl: 30 }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (metrics)
            metrics.kv_value_timeouts++
          reject(new PluginStateMiss('published value timed out'))
        }, KV_VALUE_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
    if (metrics)
      metrics.kv_value_ms += performance.now() - startedAt
  }
  if (value === null)
    throw new PluginStateMiss('published value not propagated')
  return { value, revision: pointer.generation }
}
