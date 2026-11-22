import type { KVNamespace, R2Bucket, R2ObjectBody } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStatePointer } from './pluginStateFormat.ts'
import { pluginStateImmutableKey } from './pluginStateFormat.ts'
import { PluginStateMiss } from './pluginStateRegistry.ts'
import { parsePluginStatePointer } from './pluginStateValidation.ts'

export const R2_POINTER_TIMEOUT_MS = 50
export const KV_VALUE_TIMEOUT_MS = 50
/** Background budget of each provider read that missed its request deadline. */
export const LATE_READ_TIMEOUT_MS = 2000

export interface PluginStatePublication {
  value: unknown
  revision: string | null
}

/**
 * Receives the read that missed the request deadline. The request falls back
 * either way; the caller may finish this read in the background to refill its
 * cache. Request metrics are frozen at the deadline and never include it.
 * `sampledSince` is the read's start time for timing-sampled requests, else null.
 */
export type LatePluginStateRead = (publication: Promise<PluginStatePublication>, sampledSince: number | null) => void

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

function lateDeadline<T>(read: Promise<T>, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    read,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        reject(new PluginStateMiss(`${what} timed out in the background`))
      }, LATE_READ_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

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

/**
 * Bound pointer headers and body decoding. Without `onLate` a late object is
 * discarded; with it the pointer keeps loading under the background budget.
 */
async function readPointer(
  pointers: R2Bucket,
  logicalKey: string,
  metrics: PluginStateReadMetrics | undefined,
  onLate?: (pointer: Promise<PluginStatePointer | null>) => void,
): Promise<PluginStatePointer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let keepLate = false
  let current: R2ObjectBody | null = null
  const startedAt = metrics ? performance.now() : 0
  const observation: { phase: R2PointerPhase, failure: R2PointerFailure, finished: boolean } | undefined = metrics
    ? { phase: { kind: 'headers' }, failure: 'none', finished: false }
    : undefined
  if (metrics)
    metrics.r2_pointer_reads++
  const discard = (object: R2ObjectBody | null) => { void object?.body?.cancel().catch(() => undefined) }
  const read = pointers.get(logicalKey).then(async (object) => {
    current = object
    if (timedOut && !keepLate) {
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
  })
  try {
    return await Promise.race([
      read,
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
          if (onLate) {
            keepLate = true
            onLate(lateDeadline(read, 'publication index', () => discard(current)))
          }
          else {
            discard(current)
          }
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

/** Validate a pointer and name the immutable KV value it publishes (null: nothing to read). */
async function publishedKvKey(logicalKey: string, pointer: PluginStatePointer): Promise<string | null> {
  if (pointer.kvKey === null)
    return null
  if (pointer.kvKey !== await pluginStateImmutableKey(logicalKey, pointer.generation))
    throw new PluginStateMiss('publication pointer identity mismatch')
  return pointer.kvKey
}

function getValue(store: KVNamespace, kvKey: string) {
  return store.get<unknown>(kvKey, { type: 'json', cacheTtl: 30 })
}

function publishedValue(value: unknown, revision: string): PluginStatePublication {
  if (value === null)
    throw new PluginStateMiss('published value not propagated')
  return { value, revision }
}

/** The publication of a late pointer, read entirely under the background budget. */
async function latePublication(store: KVNamespace, logicalKey: string, read: Promise<PluginStatePointer | null>): Promise<PluginStatePublication> {
  const pointer = await read
  if (!pointer)
    return { value: null, revision: null }
  const kvKey = await publishedKvKey(logicalKey, pointer)
  if (kvKey === null)
    return { value: null, revision: pointer.generation }
  return publishedValue(await lateDeadline(getValue(store, kvKey), 'published value'), pointer.generation)
}

/**
 * Strongly consistent publication index; only immutable values live in KV.
 * `onLate` receives a read that missed its request deadline (see LatePluginStateRead).
 */
export async function readPublishedPluginState(c: Context, store: KVNamespace, logicalKey: string, onLate?: LatePluginStateRead): Promise<PluginStatePublication> {
  const pointers = (c.env as { PLUGIN_STATE_POINTERS?: R2Bucket } | undefined)?.PLUGIN_STATE_POINTERS
  if (!pointers)
    throw new PluginStateMiss('publication index unavailable')
  const metrics = readMetrics.get(c.req.raw)
  const sampledSince = metrics ? performance.now() : null
  const pointer = await readPointer(pointers, logicalKey, metrics, onLate && (read => onLate(latePublication(store, logicalKey, read), sampledSince)))
  if (!pointer)
    return { value: null, revision: null }
  let kvKey: string | null
  try {
    kvKey = await publishedKvKey(logicalKey, pointer)
  }
  catch (error) {
    if (metrics?.r2_pointer_first_failure === 'none')
      metrics.r2_pointer_first_failure = 'invalid_pointer'
    throw error
  }
  if (kvKey === null)
    return { value: null, revision: pointer.generation }
  const startedAt = metrics ? performance.now() : 0
  if (metrics)
    metrics.kv_value_reads++
  let value: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = getValue(store, kvKey)
  try {
    value = await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (metrics)
            metrics.kv_value_timeouts++
          onLate?.(lateDeadline(read, 'published value').then(late => publishedValue(late, pointer.generation)), sampledSince)
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
  return publishedValue(value, pointer.generation)
}
