import type { KVNamespacePutOptions, R2Conditional, R2ListOptions } from '@cloudflare/workers-types'
import { vi } from 'vitest'
import { parsePluginStatePointer } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateValidation.ts'

/** Provider stand-ins preserve atomic ETag preconditions and snapshot reads. */
export function publicationProviders() {
  const values = new Map<string, { body: string, metadata: unknown }>()
  const objects = new Map<string, { body: string, etag: string, customMetadata?: Record<string, string> }>()
  let revision = 0
  const namespace = {
    get: vi.fn(async (key: string) => {
      const value = values.get(key)
      return value ? JSON.parse(value.body) : null
    }),
    put: vi.fn(async (key: string, body: string, options?: KVNamespacePutOptions) => {
      values.set(key, { body, metadata: options?.metadata })
    }),
    delete: vi.fn(async (key: string) => { values.delete(key) }),
    list: vi.fn(async (options: { prefix: string, limit: number, cursor?: string }) => {
      const found = [...values].filter(([key]) => key.startsWith(options.prefix)).sort(([left], [right]) => left.localeCompare(right))
      const start = options.cursor ? found.findIndex(([key]) => key > options.cursor!) : 0
      const page = start < 0 ? [] : found.slice(start, start + options.limit)
      const complete = start < 0 || start + page.length >= found.length
      return {
        keys: page.map(([name, value]) => ({ name, metadata: value.metadata })),
        list_complete: complete,
        cursor: complete ? undefined : page.at(-1)?.[0],
      }
    }),
  }
  const pointers = {
    get: vi.fn(async (key: string) => {
      const object = objects.get(key)
      return object ? { etag: object.etag, json: async () => JSON.parse(object.body) } : null
    }),
    put: vi.fn(async (key: string, body: string, options: { onlyIf: R2Conditional, httpMetadata: { contentType: string }, customMetadata?: Record<string, string> }) => {
      const previous = objects.get(key)
      if (options.onlyIf.etagMatches !== undefined && previous?.etag !== options.onlyIf.etagMatches)
        return null
      if (options.onlyIf.etagDoesNotMatch === '*' && previous)
        return null
      const object = { body, etag: `etag-${++revision}`, customMetadata: options.customMetadata }
      objects.set(key, object)
      return object
    }),
    list: vi.fn(async (options: R2ListOptions) => ({
      objects: [...objects].filter(([key]) => key.startsWith(options.prefix ?? '')).map(([key, object]) => ({
        key, etag: object.etag, customMetadata: options.include?.includes('customMetadata') ? object.customMetadata : undefined,
      })),
      truncated: false,
    })),
  }
  function publishedValue(key: string): unknown {
    const object = objects.get(key)
    if (!object)
      return null
    const pointer = parsePluginStatePointer(JSON.parse(object.body))
    const value = pointer.kvKey ? values.get(pointer.kvKey) : null
    return value ? JSON.parse(value.body) : null
  }
  return { namespace, pointers, values, objects, publishedValue }
}
