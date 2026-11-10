import { describe, expect, it } from 'vitest'
import { pluginStateImmutableKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { collectPluginStateGarbage, createPluginStateSyncStore } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
import { publicationProviders } from './plugin-state-publication-fixture.ts'

const KEY = 'ps1:v:com.test.publication:1.0.0'

describe('plugin state fenced publication', () => {
  it.concurrent('rejects an old publisher that resumes after its replacement commits', async () => {
    const provider = publicationProviders()
    const oldImmutable = await pluginStateImmutableKey(KEY, '1')
    const oldWriteStarted = Promise.withResolvers<void>()
    const resumeOldWrite = Promise.withResolvers<void>()
    const write = provider.namespace.put.getMockImplementation()!
    provider.namespace.put.mockImplementation(async (key, value, options) => {
      if (key === oldImmutable) {
        oldWriteStarted.resolve()
        await resumeOldWrite.promise
      }
      await write(key, value, options)
    })
    const old = createPluginStateSyncStore(provider.namespace, provider.pointers, '1')
    const replacement = createPluginStateSyncStore(provider.namespace, provider.pointers, '2')
    const late = old.putJson(KEY, { id: 1 })
    await oldWriteStarted.promise
    await replacement.putJson(KEY, { id: 2 })
    resumeOldWrite.resolve()
    await late
    expect(provider.publishedValue(KEY)).toEqual({ id: 2 })
    expect(provider.values.has(oldImmutable)).toBe(true)
  })

  it.concurrent('keeps deletion tombstones fenced against delayed older writes', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '2').delete(KEY)
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').putJson(KEY, { id: 1 })
    expect(JSON.parse(provider.objects.get(KEY)!.body)).toMatchObject({ generation: '2', kvKey: null })
    expect(provider.namespace.put).not.toHaveBeenCalled()
  })

  it.concurrent('counts KV and R2 operations against one shared budget', async () => {
    const provider = publicationProviders()
    const budget = { remaining: 3 }
    const store = createPluginStateSyncStore(provider.namespace, provider.pointers, '1', budget)
    await store.putJson(KEY, { id: 1 })
    expect(budget.remaining).toBe(0)
    await expect(store.putJson(`${KEY}-other`, { id: 2 })).rejects.toThrow('operation budget exhausted')
    expect(provider.pointers.get).toHaveBeenCalledTimes(1)
    expect(provider.namespace.put).toHaveBeenCalledTimes(1)
    expect(provider.pointers.put).toHaveBeenCalledTimes(1)
  })

  it.concurrent('stops compare-and-set retries after five failed attempts', async () => {
    const provider = publicationProviders()
    provider.pointers.put.mockResolvedValue(null)
    const store = createPluginStateSyncStore(provider.namespace, provider.pointers, '1')
    await expect(store.putJson(KEY, { id: 1 })).rejects.toThrow('exceeded 5 attempts')
    expect(provider.pointers.put).toHaveBeenCalledTimes(5)
  })
})

describe('cleanup listing preconditions', () => {
  it.concurrent('refreshes a tombstone fence from listing metadata without another GET', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').delete(KEY)
    provider.pointers.get.mockClear()
    provider.pointers.put.mockClear()
    const budget = { remaining: 3 }
    const cleanup = createPluginStateSyncStore(provider.namespace, provider.pointers, '3', budget)
    const listed = await cleanup.list({ prefix: 'ps1:v:', limit: 48 })
    await cleanup.deleteListed(listed.keys[0])
    expect(provider.pointers.list).toHaveBeenCalledWith({ prefix: 'ps1:v:', limit: 48, include: ['customMetadata'] })
    expect(provider.pointers.get).not.toHaveBeenCalled()
    expect(provider.pointers.put).toHaveBeenCalledTimes(1)
    expect(budget.remaining).toBe(1)
    const pointer = provider.objects.get(KEY)!
    expect(JSON.parse(pointer.body)).toMatchObject({ generation: '3', kvKey: null })
    expect(pointer.customMetadata).toEqual({ generation: '3' })
  })

  it.concurrent('fences a paused generation newer than the old tombstone after cleanup', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').delete(KEY)
    const oldImmutable = await pluginStateImmutableKey(KEY, '2')
    const oldWriteStarted = Promise.withResolvers<void>()
    const resumeOldWrite = Promise.withResolvers<void>()
    const write = provider.namespace.put.getMockImplementation()!
    provider.namespace.put.mockImplementation(async (key, value, options) => {
      if (key === oldImmutable) {
        oldWriteStarted.resolve()
        await resumeOldWrite.promise
      }
      await write(key, value, options)
    })
    const late = createPluginStateSyncStore(provider.namespace, provider.pointers, '2').putJson(KEY, { id: 2 })
    await oldWriteStarted.promise
    const cleanup = createPluginStateSyncStore(provider.namespace, provider.pointers, '3')
    const listed = await cleanup.list({ prefix: 'ps1:v:', limit: 48 })
    await cleanup.deleteListed(listed.keys[0])
    resumeOldWrite.resolve()
    await late
    expect(JSON.parse(provider.objects.get(KEY)!.body)).toMatchObject({ generation: '3', kvKey: null })
    expect(provider.publishedValue(KEY)).toBeNull()
  })

  it.concurrent.each([undefined, 'invalid', '0', '9223372036854775808'])('reads legacy or invalid generation metadata before deleting: %s', async (generation) => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').delete(KEY)
    const previous = provider.objects.get(KEY)!
    provider.objects.set(KEY, { ...previous, customMetadata: generation === undefined ? undefined : { generation } })
    provider.pointers.get.mockClear()
    const cleanup = createPluginStateSyncStore(provider.namespace, provider.pointers, '3')
    const listed = await cleanup.list({ prefix: 'ps1:v:', limit: 48 })
    await cleanup.deleteListed(listed.keys[0])
    expect(provider.pointers.get).toHaveBeenCalledTimes(1)
    expect(JSON.parse(provider.objects.get(KEY)!.body)).toMatchObject({ generation: '3', kvKey: null })
  })

  it.concurrent('refreshes a stale listing precondition and preserves a newer winner', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').delete(KEY)
    const cleanup = createPluginStateSyncStore(provider.namespace, provider.pointers, '3')
    const listed = await cleanup.list({ prefix: 'ps1:v:', limit: 48 })
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '4').putJson(KEY, { id: 4 })
    provider.pointers.get.mockClear()
    provider.pointers.put.mockClear()
    await cleanup.deleteListed(listed.keys[0])
    expect(provider.pointers.get).toHaveBeenCalledTimes(1)
    expect(provider.pointers.put).toHaveBeenCalledTimes(1)
    expect(provider.publishedValue(KEY)).toEqual({ id: 4 })
  })

  it.concurrent('retries a stale listing ETag when the competing generation is older than cleanup', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').delete(KEY)
    const cleanup = createPluginStateSyncStore(provider.namespace, provider.pointers, '3')
    const listed = await cleanup.list({ prefix: 'ps1:v:', limit: 48 })
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '2').putJson(KEY, { id: 2 })
    provider.pointers.get.mockClear()
    provider.pointers.put.mockClear()
    await cleanup.deleteListed(listed.keys[0])
    expect(provider.pointers.get).toHaveBeenCalledTimes(1)
    expect(provider.pointers.put).toHaveBeenCalledTimes(2)
    expect(JSON.parse(provider.objects.get(KEY)!.body)).toMatchObject({ generation: '3', kvKey: null })
  })
})

describe('plugin immutable state garbage collection', () => {
  it.concurrent('deletes obsolete generations after the grace period and retains the current value', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').putJson(KEY, { id: 1 })
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '2').putJson(KEY, { id: 2 })
    const budget = { remaining: 800 }
    const progress = await collectPluginStateGarbage(provider.namespace, provider.pointers, {
      budget, cursor: null, deadline: Date.now() + 1000, now: Date.now() + 2 * 24 * 60 * 60 * 1000,
    })
    expect(progress).toEqual({ cursor: null, complete: true, deleted: 1 })
    expect(provider.values.has(await pluginStateImmutableKey(KEY, '1'))).toBe(false)
    expect(provider.values.has(await pluginStateImmutableKey(KEY, '2'))).toBe(true)
    expect(provider.publishedValue(KEY)).toEqual({ id: 2 })
    expect(budget.remaining).toBeGreaterThanOrEqual(796)
  })

  it.concurrent('retains an unpublished future generation until a newer pointer fences its publisher', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').putJson(KEY, { id: 1 })
    const futureKey = await pluginStateImmutableKey(KEY, '2')
    provider.values.set(futureKey, {
      body: JSON.stringify({ id: 2 }),
      metadata: { logical_key: KEY, generation: '2', written_at: Date.now() },
    })
    const options = { budget: { remaining: 800 }, cursor: null, deadline: Date.now() + 1000, now: Date.now() + 2 * 24 * 60 * 60 * 1000 }
    const first = await collectPluginStateGarbage(provider.namespace, provider.pointers, options)
    expect(first.deleted).toBe(0)
    expect(provider.values.has(futureKey)).toBe(true)
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '3').putJson(KEY, { id: 3 })
    const next = await collectPluginStateGarbage(provider.namespace, provider.pointers, { ...options, budget: { remaining: 800 } })
    expect(next.deleted).toBe(2)
    expect(provider.values.has(futureKey)).toBe(false)
    expect(provider.publishedValue(KEY)).toEqual({ id: 3 })
  })

  it.concurrent('replays an interrupted listing page instead of skipping unvisited keys', async () => {
    const provider = publicationProviders()
    await createPluginStateSyncStore(provider.namespace, provider.pointers, '1').putJson(KEY, { id: 1 })
    const progress = await collectPluginStateGarbage(provider.namespace, provider.pointers, {
      budget: { remaining: 800 }, cursor: null, deadline: Date.now() - 1, now: Date.now() + 2 * 24 * 60 * 60 * 1000,
    })
    expect(progress).toEqual({ cursor: null, complete: false, deleted: 0 })
    expect(provider.namespace.delete).not.toHaveBeenCalled()
  })
})
