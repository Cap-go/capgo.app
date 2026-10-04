import type { InventoryRow } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { describe, expect, it, vi } from 'vitest'
import { compareKeys, listWithCursorFallback, prefixUpperBound, reconcileRange, validatePage } from '../scripts/r2_inventory/scan.ts'

const object = (key: string) => ({ key, size: 42, etag: 'etag', lastModified: '2026-01-01T00:00:00Z' })
const row = (key: string): InventoryRow => ({ r2_key: key, r2_state: 'present', size_bytes: '42', etag: 'etag', revision: '1', event_us: null, reconciled_us: null, first_seen_us: '1', cleanup_requested_at: null })
const snapshot = (keys: string[]) => ({ startedAt: new Date().toISOString(), rows: keys.map(row) })

describe('r2 LIST scan boundaries', () => {
  it('uses UTF-8 ordering and bounded Unicode prefixes', () => {
    expect(compareKeys('\uE000', '😀')).toBeLessThan(0)
    expect(prefixUpperBound('objects/')).toBe('objects0')
    expect(prefixUpperBound('')).toBeNull()
    expect(prefixUpperBound('a\u{10FFFF}')).toBe('b')
  })
  it('does not infer absence beyond a truncated page', () => {
    const range = reconcileRange(snapshot(['a', 'z']), { objects: [object('b')], truncated: true, token: 'next' })
    expect(range.upper).toBe('b')
    expect(range.observations.map(item => [item.key, item.object !== null])).toEqual([['b', true], ['a', false]])
    expect(range.complete).toBe(false)
  })
  it('stops at a database boundary when the provider page extends beyond it', () => {
    const range = reconcileRange(snapshot(['b']), { objects: [object('a'), object('z')], truncated: false })
    expect(range.upper).toBe('b')
    expect(range.observations.map(item => item.key)).toEqual(['a', 'b'])
    expect(range.complete).toBe(false)
  })
  it('processes the provider-only tail before marking the scan complete', () => {
    const range = reconcileRange(snapshot([]), { objects: [object('z')], truncated: false })
    expect(range.observations[0].key).toBe('z')
    expect(range.complete).toBe(true)
  })
  it('does not treat absent reservations as deleted objects', () => {
    const captured = snapshot(['pending'])
    captured.rows[0].r2_state = 'to_be_uploaded'
    expect(reconcileRange(captured, { objects: [], truncated: false }).observations).toEqual([])
  })
  it('rejects empty truncated pages, unsorted objects and invalid metadata', () => {
    expect(() => validatePage({ objects: [], truncated: true, token: 'x' }, { prefix: '' })).toThrow()
    expect(() => validatePage({ objects: [object('z'), object('a')], truncated: false }, { prefix: '' })).toThrow()
    expect(() => validatePage({ objects: [object('other/file')], truncated: false }, { prefix: 'prefix/' })).toThrow()
    expect(() => validatePage({ objects: [object('a')], truncated: false }, { prefix: '', startAfter: 'a' })).toThrow()
  })
  it('falls back from an invalid continuation token to the committed key', async () => {
    const list = vi.fn().mockRejectedValueOnce({ name: 'InvalidArgument' }).mockResolvedValueOnce({ objects: [], truncated: false })
    await listWithCursorFallback(list, { prefix: 'prefix/', token: 'expired', startAfter: 'prefix/last' })
    expect(list.mock.calls[1][0]).toEqual({ prefix: 'prefix/', startAfter: 'prefix/last' })
  })
  it('does not mistake a provider outage for an expired cursor', async () => {
    const list = vi.fn().mockRejectedValue(new Error('Provider unavailable'))
    await expect(listWithCursorFallback(list, { prefix: '', token: 'cursor', startAfter: 'a' })).rejects.toThrow('Provider unavailable')
    expect(list).toHaveBeenCalledTimes(1)
  })
})
