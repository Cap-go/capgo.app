import type { ScanOptions } from '../scripts/r2_inventory/scan.ts'
import { Client } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { collectInventoryTombstones, commitBackfillPage, completedBackfillVersion, EMPTY_PROGRESS, loadProgress, restartCompletedScan, scanInventory } from '../scripts/r2_inventory/scan.ts'
import { applyInventoryEvents } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { POSTGRES_URL } from './test-utils.ts'

const config = { enabled: true, tombstoneDays: 7, minBatchMs: 500 }
const object = (key: string) => ({ key, size: 42, etag: 'etag', lastModified: '2026-01-01T00:00:00Z' })
async function fixture(operation: (db: Client, options: ScanOptions) => Promise<void>) {
  const db = new Client({ connectionString: POSTGRES_URL })
  await db.connect()
  const options: ScanOptions = { bucket: `scan-${crypto.randomUUID()}`, prefix: '', job: 'initial', mode: 'backfill', write: true, maxPages: 1, intervalMs: 1000 }
  try {
    await operation(db, options)
  }
  finally {
    await db.query('DELETE FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])
    await db.query(`DELETE FROM public.r2_inventory_checkpoints WHERE bucket_name = $1 AND job_name <> 'admission'`, [options.bucket])
    await db.end()
  }
}

describe('resumable inventory scans', () => {
  it.concurrent('stops during pacing after committing the current page and its resume cursor', () => fixture(async (db, options) => {
    options.maxPages = 2
    options.intervalMs = 60_000
    const shutdown = new AbortController()
    const list = vi.fn().mockResolvedValue({ objects: [object('a')], truncated: true, token: 'next' })
    const progress = await scanInventory(db, list, options, config, () => {
      setTimeout(() => shutdown.abort(), 0)
    }, () => false, shutdown.signal)
    expect(list).toHaveBeenCalledTimes(1)
    expect(progress).toMatchObject({ lastKey: 'a', pages: 1, complete: false })
    expect(await loadProgress(db, options)).toEqual(progress)
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])).rows[0].count).toBe(1)
  }))

  it.concurrent('invalidates earlier reconciliation when a completed backfill restarts', () => fixture(async (db, options) => {
    await commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [], truncated: false }, new Date().toISOString())
    options.mode = 'reconcile'
    await scanInventory(db, async () => ({ objects: [], truncated: false }), options, config)
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(0)
    options.mode = 'backfill'
    await restartCompletedScan(db, options)
    await commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [], truncated: false }, new Date().toISOString())
    await expect(collectInventoryTombstones(db, options.bucket, options.job, config)).rejects.toThrow('requires completed')
    options.mode = 'reconcile'
    await expect(scanInventory(db, async () => ({ objects: [], truncated: false }), options, config)).rejects.toThrow('predates')
    await restartCompletedScan(db, options)
    await scanInventory(db, async () => ({ objects: [], truncated: false }), options, config)
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(0)
  }))
  it.concurrent('rejects a backfill restart racing with an in-flight reconciliation observation', () => fixture(async (db, options) => {
    await commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [], truncated: false }, new Date().toISOString())
    options.mode = 'reconcile'
    const list = async () => {
      const backfill = { ...options, mode: 'backfill' as const }
      await restartCompletedScan(db, backfill)
      await commitBackfillPage(db, backfill, { ...EMPTY_PROGRESS }, { objects: [], truncated: false }, new Date().toISOString())
      return { objects: [object('a')], truncated: false }
    }
    await expect(scanInventory(db, list, options, config)).rejects.toMatchObject({ originalError: expect.objectContaining({ message: expect.stringContaining('Backfill changed') }) })
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])).rows[0].count).toBe(0)
  }))

  it.concurrent('clears historical modification metadata when a newer create replaces the key', () => fixture(async (db, options) => {
    await commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [object('a')], truncated: false }, new Date(Date.now() - 60_000).toISOString())
    await applyInventoryEvents(db, [{ bucket: options.bucket, key: 'a', state: 'present', size: 99, etag: 'replacement', eventTime: new Date().toISOString() }], config)
    const result = await db.query('SELECT size_bytes, etag, r2_last_modified_at FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])
    expect(result.rows[0]).toEqual({ size_bytes: '99', etag: 'replacement', r2_last_modified_at: null })
  }))

  it.concurrent('restarts only completed scans and records a bounded failed-page context', () => fixture(async (db, options) => {
    await expect(restartCompletedScan(db, options)).rejects.toThrow('Only a completed')
    await scanInventory(db, async () => ({ objects: [object('a')], truncated: false }), options, config)
    await restartCompletedScan(db, options)
    expect(await loadProgress(db, options)).toEqual(EMPTY_PROGRESS)
    const failed = scanInventory(db, async () => ({ objects: [object('z'), object('b')], truncated: false }), options, config)
    await expect(failed).rejects.toMatchObject({ progress: EMPTY_PROGRESS, keys: ['z', 'b'] })
    expect(await loadProgress(db, options)).toEqual(EMPTY_PROGRESS)
  }))

  it.concurrent('handles a range containing 1000 new objects and 1000 absent database keys', () => fixture(async (db, options) => {
    const key = (index: number) => `key-${String(index).padStart(4, '0')}`
    const known = Array.from({ length: 1000 }, (_, i) => key(i * 2))
    await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state) SELECT $1, key, 'present' FROM unnest($2::text[]) AS key`, [options.bucket, known])
    const remote = Array.from({ length: 1000 }, (_, i) => object(key(i * 2 + 1)))
    await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, checkpoint) VALUES ($1, 'backfill:initial', $2::jsonb) ON CONFLICT DO NOTHING`, [options.bucket, JSON.stringify({ ...EMPTY_PROGRESS, complete: true })])
    options.mode = 'reconcile'
    const list = async (request: { startAfter?: string }) => ({ objects: remote.filter(item => item.key > (request.startAfter ?? '')), truncated: false })
    const first = await scanInventory(db, list, options, config)
    expect(first.skipped).toBe(0)
    const second = await scanInventory(db, list, options, config)
    expect(second.complete).toBe(true)
    const result = await db.query(`SELECT r2_state, count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1 GROUP BY r2_state ORDER BY r2_state`, [options.bucket])
    expect(result.rows).toEqual([{ r2_state: 'present', count: 1000 }, { r2_state: 'deleted', count: 1000 }])
  }))

  it.concurrent('backfills historical objects without overwriting a newer tombstone and resumes from a committed cursor', () => fixture(async (db, options) => {
    await applyInventoryEvents(db, [{ bucket: options.bucket, key: 'a', state: 'deleted', size: null, etag: null, eventTime: new Date().toISOString() }], config)
    const list = vi.fn().mockResolvedValueOnce({ objects: [object('a'), object('b')], truncated: true, token: 'next' }).mockResolvedValueOnce({ objects: [object('c')], truncated: false })
    const first = await scanInventory(db, list, options, config)
    expect(first.lastKey).toBe('b')
    expect(first.complete).toBe(false)
    const second = await scanInventory(db, list, options, config)
    expect(list.mock.calls[1][0]).toMatchObject({ token: 'next', startAfter: 'b' })
    expect(second.complete).toBe(true)
    expect(second.objects).toBe(3)
    const result = await db.query('SELECT r2_key, r2_state FROM public.r2_objects WHERE bucket_name = $1 ORDER BY r2_key', [options.bucket])
    expect(result.rows).toEqual([{ r2_key: 'a', r2_state: 'deleted' }, { r2_key: 'b', r2_state: 'present' }, { r2_key: 'c', r2_state: 'present' }])
    await scanInventory(db, list, options, config)
    expect(list).toHaveBeenCalledTimes(2)
  }))
  it.concurrent('rolls back page inserts and checkpoint advancement together', () => fixture(async (db, options) => {
    await expect(commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [object('a'), { ...object('b'), size: -1 }], truncated: false }, new Date().toISOString())).rejects.toThrow()
    expect(await loadProgress(db, options)).toEqual(EMPTY_PROGRESS)
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])).rows[0].count).toBe(0)
  }))
  it.concurrent('rejects competing checkpoint writers without inserting their page', () => fixture(async (db, options) => {
    await commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [object('a')], truncated: true, token: 'next' }, new Date().toISOString())
    await expect(commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [object('b')], truncated: false }, new Date().toISOString())).rejects.toThrow('Checkpoint advanced')
    expect((await db.query('SELECT r2_key FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])).rows.map(row => row.r2_key)).toEqual(['a'])
  }))
  it.concurrent('keeps dry-run scans free of object and checkpoint writes', () => fixture(async (db, options) => {
    await scanInventory(db, async () => ({ objects: [object('a')], truncated: false }), { ...options, write: false }, config)
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])).rows[0].count).toBe(0)
    expect(await loadProgress(db, options)).toEqual(EMPTY_PROGRESS)
  }))
  it.concurrent('reconciles missing objects and unknown keys without HEAD or overwriting a concurrent event', () => fixture(async (db, options) => {
    await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state) VALUES ($1, 'a', 'present'), ($1, 'z', 'present')`, [options.bucket])
    await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, checkpoint) VALUES ($1, 'backfill:initial', $2::jsonb) ON CONFLICT DO NOTHING`, [options.bucket, JSON.stringify({ ...EMPTY_PROGRESS, complete: true })])
    options.mode = 'reconcile'
    const list = vi.fn().mockImplementationOnce(async () => {
      await db.query(`UPDATE public.r2_objects SET size_bytes = 999 WHERE bucket_name = $1 AND r2_key = 'z'`, [options.bucket])
      return { objects: [object('b'), object('z')], truncated: false }
    })
    const first = await scanInventory(db, list, options, config)
    expect(first.skipped).toBe(1)
    const rows = (await db.query('SELECT r2_key, r2_state, size_bytes FROM public.r2_objects WHERE bucket_name = $1 ORDER BY r2_key', [options.bucket])).rows
    expect(rows).toEqual([{ r2_key: 'a', r2_state: 'deleted', size_bytes: null }, { r2_key: 'b', r2_state: 'present', size_bytes: '42' }, { r2_key: 'z', r2_state: 'present', size_bytes: '999' }])
  }))
  it.concurrent('advances GC beyond a protected prefix and revisits it after wrapping', () => fixture(async (db, options) => {
    await commitBackfillPage(db, options, { ...EMPTY_PROGRESS }, { objects: [], truncated: false }, new Date().toISOString())
    options.mode = 'reconcile'
    await scanInventory(db, async () => ({ objects: [], truncated: false }), options, config)
    await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state, last_event_at, tombstone_expires_at)
      SELECT $1, CASE WHEN i <= 1000 THEN 'protected-' || lpad(i::text, 4, '0') ELSE 'z-eligible' END, 'deleted',
        CASE WHEN i <= 1000 THEN now() ELSE now() - interval '10 days' END, now() - interval '1 day'
      FROM generate_series(1, 1001) AS i`, [options.bucket])
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(0)
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(1)
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [options.bucket])).rows[0].count).toBe(1000)
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(0)
    await db.query(`UPDATE public.r2_objects SET last_event_at = now() - interval '10 days' WHERE bucket_name = $1`, [options.bucket])
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(1000)
  }))
  it.concurrent('requires complete validation before collecting tombstones and rejects old replay after history is purged', () => fixture(async (db, options) => {
    await expect(collectInventoryTombstones(db, options.bucket, options.job, config)).rejects.toThrow('requires completed')
    for (const mode of ['backfill', 'reconcile']) {
      await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, checkpoint) VALUES ($1, $2, $3::jsonb)`, [options.bucket, `${mode}:${options.job}`, JSON.stringify({ ...EMPTY_PROGRESS, complete: true })])
    }
    const version = await completedBackfillVersion(db, options)
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint = checkpoint || jsonb_build_object('backfillVersion', $2::text) WHERE bucket_name = $1 AND job_name = 'reconcile:initial'`, [options.bucket, version])
    await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state, last_event_at, tombstone_expires_at) VALUES ($1, 'old', 'deleted', now() - interval '10 days', now() - interval '1 day')`, [options.bucket])
    expect(await collectInventoryTombstones(db, options.bucket, options.job, config)).toBe(1)
    expect(await applyInventoryEvents(db, [{ bucket: options.bucket, key: 'old', state: 'present', size: 42, etag: 'etag', eventTime: new Date(Date.now() - 10 * 86400_000).toISOString() }], config)).toEqual([{ bucket: options.bucket, key: 'old', kind: 'verify' }])
  }))
})
