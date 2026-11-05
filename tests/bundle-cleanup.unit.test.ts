import { describe, expect, it, vi } from 'vitest'
import { planBundleCleanup } from '../supabase/functions/_backend/public/bundle/cleanup.ts'
import { lockBundleLifecycles, retryOnDeadlock, softDeleteLockedBundles } from '../supabase/functions/_backend/utils/bundle_soft_delete.ts'

// Newest first, the order the endpoint selects them in.
const versions = [
  { id: 6, name: '2.0.0', created_at: '2024-01-06T00:00:00Z' },
  { id: 5, name: '1.0.4', created_at: '2024-01-05T00:00:00Z' },
  { id: 4, name: '1.0.3', created_at: '2024-01-04T00:00:00Z' },
  { id: 3, name: 'builtin', created_at: '2024-01-03T00:00:00Z' },
  { id: 7, name: 'unknown', created_at: '2024-01-02T12:00:00Z' },
  { id: 2, name: '1.0.1', created_at: '2024-01-02T00:00:00Z' },
  { id: 1, name: '1.0.0', created_at: '2024-01-01T00:00:00Z' },
]

const names = (rows: { name: string }[]) => rows.map(row => row.name)

describe('planBundleCleanup', () => {
  it('keeps the newest bundles and removes the rest, never touching placeholders', () => {
    const plan = planBundleCleanup(versions, new Set(), { keep: 2, ignoreChannel: false })
    expect(plan.active).toBe(5)
    expect(plan.total).toBe(5)
    expect(names(plan.kept)).toEqual(['2.0.0', '1.0.4'])
    expect(names(plan.removed)).toEqual(['1.0.3', '1.0.1', '1.0.0'])
  })

  it('always keeps channel-linked bundles unless ignoreChannel is set', () => {
    const linked = new Set([2])
    const plan = planBundleCleanup(versions, linked, { keep: 1, ignoreChannel: false })
    expect(names(plan.kept)).toEqual(['2.0.0', '1.0.1'])
    expect(plan.kept.find(row => row.id === 2)?.linked).toBe(true)
    expect(names(plan.removed)).toEqual(['1.0.4', '1.0.3', '1.0.0'])

    const ignored = planBundleCleanup(versions, linked, { keep: 1, ignoreChannel: true })
    expect(names(ignored.removed)).toEqual(['1.0.4', '1.0.3', '1.0.1', '1.0.0'])
  })

  it('limits cleanup to versions above `bundle` and below its next major', () => {
    const plan = planBundleCleanup(versions, new Set(), { keep: 1, bundle: '1.0.0', ignoreChannel: false })
    expect(plan.active).toBe(5)
    expect(plan.total).toBe(3)
    expect(names(plan.kept)).toEqual(['1.0.4'])
    expect(names(plan.removed)).toEqual(['1.0.3', '1.0.1'])
  })

  it('keeps an empty range distinct from an app without bundles', () => {
    const outOfRange = planBundleCleanup(versions, new Set(), { keep: 1, bundle: '7.0.0', ignoreChannel: false })
    expect(outOfRange).toMatchObject({ active: 5, total: 0, kept: [], removed: [] })

    const placeholdersOnly = planBundleCleanup(versions.filter(v => v.name === 'builtin' || v.name === 'unknown'), new Set(), { keep: 0, ignoreChannel: false })
    expect(placeholdersOnly).toMatchObject({ active: 0, total: 0, removed: [] })
  })

  it('rejects an invalid `bundle` filter', () => {
    expect(() => planBundleCleanup(versions, new Set(), { keep: 1, bundle: 'nope', ignoreChannel: false })).toThrow()
  })
})

describe('retryOnDeadlock', () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' })

  it('retries a deadlock victim and returns the next result', async () => {
    const fn = vi.fn().mockRejectedValueOnce(deadlock).mockResolvedValueOnce([1, 2])
    await expect(retryOnDeadlock(fn)).resolves.toEqual([1, 2])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('rethrows any other error without retrying', async () => {
    const failure = Object.assign(new Error('boom'), { code: '23505' })
    const fn = vi.fn().mockRejectedValue(failure)
    await expect(retryOnDeadlock(fn)).rejects.toBe(failure)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget', async () => {
    const fn = vi.fn().mockRejectedValue(deadlock)
    await expect(retryOnDeadlock(fn, 3)).rejects.toBe(deadlock)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('bundle soft-delete helpers', () => {
  function fakeTx(rows: unknown[] = []) {
    const queries: { text: string, params?: unknown[] }[] = []
    const tx = {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params })
        return { rows: text.includes('UPDATE') ? rows : [] } as any
      },
    }
    return { tx, queries }
  }

  it('locks every bundle through the lifecycle helper in id order', async () => {
    const { tx, queries } = fakeTx()
    await lockBundleLifecycles(tx, [9, 3])
    expect(queries).toHaveLength(1)
    expect(queries[0].text).toContain('lock_channel_bundle_lifecycle(id, NULL)')
    expect(queries[0].text).toContain('ORDER BY id')
    expect(queries[0].params).toEqual([[9, 3]])
  })

  it('attributes the write to the caller key, then deletes and returns numeric ids', async () => {
    const { tx, queries } = fakeTx([{ id: '3' }, { id: 9 }])
    await expect(softDeleteLockedBundles(tx, 'caller-key', 'com.test.app', [3, 9], false)).resolves.toEqual([3, 9])
    expect(queries[0].text).toContain('set_config')
    expect(queries[0].params).toEqual([JSON.stringify({ capgkey: 'caller-key' })])
    expect(queries[1].text).toContain('UPDATE public.app_versions')
    expect(queries[1].params).toEqual(['com.test.app', [3, 9], false])
  })
})

