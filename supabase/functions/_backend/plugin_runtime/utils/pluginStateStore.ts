import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import { pluginStateImmutableKey } from './pluginStateFormat.ts'
import { PluginStateMiss } from './pluginStateRegistry.ts'
import { parsePluginStatePointer } from './pluginStateValidation.ts'

/** Strongly consistent publication index; only immutable values live in KV. */
export async function readPublishedPluginState(c: Context, store: KVNamespace, logicalKey: string): Promise<{ value: unknown, revision: string | null }> {
  const pointers = (c.env as { PLUGIN_STATE_POINTERS?: R2Bucket } | undefined)?.PLUGIN_STATE_POINTERS
  if (!pointers)
    throw new PluginStateMiss('publication index unavailable')
  const object = await pointers.get(logicalKey)
  if (!object)
    return { value: null, revision: null }
  const pointer = parsePluginStatePointer(await object.json<unknown>())
  if (pointer.kvKey === null)
    return { value: null, revision: pointer.generation }
  if (pointer.kvKey !== await pluginStateImmutableKey(logicalKey, pointer.generation))
    throw new PluginStateMiss('publication pointer identity mismatch')
  const value = await store.get<unknown>(pointer.kvKey, { type: 'json', cacheTtl: 30 })
  if (value === null)
    throw new PluginStateMiss('published value not propagated')
  return { value, revision: pointer.generation }
}
