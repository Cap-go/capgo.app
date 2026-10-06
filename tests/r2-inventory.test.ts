import type { ClientBase } from 'pg'
import type { InventoryEvent } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { applyInventoryEvents, applyObservations, inventoryTransaction, readObservationSnapshot } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { POSTGRES_URL } from './test-utils.ts'

const config = { tombstoneDays: 7 }
async function fixture(operation: (db: ClientBase, bucket: string, event: (key: string, delta?: number, state?: 'present' | 'deleted') => InventoryEvent) => Promise<void>) {
  const db = new Client({ connectionString: POSTGRES_URL })
  await db.connect()
  const bucket = `r2-inventory-${crypto.randomUUID()}`
  const base = Date.now() - 60_000
  const event = (key: string, delta = 0, state: 'present' | 'deleted' = 'present'): InventoryEvent => ({ bucket, key, state, eventTime: new Date(base + delta).toISOString(), size: state === 'present' ? 42 : null, etag: state === 'present' ? 'etag' : null })
  try {
    await operation(db, bucket, event)
  }
  finally {
    await db.query('DELETE FROM public.r2_objects WHERE bucket_name = $1', [bucket])
    await db.query('DELETE FROM public.r2_inventory_checkpoints WHERE bucket_name = $1 AND job_name <> \'admission\'', [bucket])
    await db.end()
  }
}

describe('r2 inventory atomic ingestion', () => {
  it.concurrent('rolls back failed writes on the existing client and can commit a subsequent batch', () => fixture(async (db, bucket, event) => {
    const original = new Error('Synthetic inventory transaction failure')
    await expect(inventoryTransaction(db, async () => {
      const settings = await db.query(`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`)
      expect(settings.rows[0]).toEqual({ statement_timeout: '10s', lock_timeout: '5s' })
      await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state) VALUES ($1, 'failed', 'present')`, [bucket])
      throw original
    })).rejects.toBe(original)
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].count).toBe(0)
    await applyInventoryEvents(db, [event('committed')], config)
    expect((await db.query('SELECT r2_key FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows).toEqual([{ r2_key: 'committed' }])
  }))

  it.concurrent('does not overwrite a purged and reinserted key with the same revision', () => fixture(async (db, bucket, event) => {
    await applyInventoryEvents(db, [event('key')], config)
    const snapshot = await readObservationSnapshot(db, bucket, ['key'])
    await db.query('DELETE FROM public.r2_objects WHERE bucket_name = $1', [bucket])
    await applyInventoryEvents(db, [event('key', 1000)], config)
    expect(await applyObservations(db, bucket, snapshot, [{ key: 'key', object: null }], config)).toEqual(['key'])
  }))

  it.concurrent('serializes competing insert/update batches for the same physical key', () => fixture(async (db, bucket, event) => {
    const second = new Client({ connectionString: POSTGRES_URL })
    await second.connect()
    try {
      await Promise.all([applyInventoryEvents(db, [event('key')], config), applyInventoryEvents(second, [event('key', 1000, 'deleted')], config)])
      expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('deleted')
    }
    finally {
      await second.end()
    }
  }))
  it.concurrent('does not trust future-dated notifications', () => fixture(async (db, bucket, event) => {
    expect(await applyInventoryEvents(db, [event('future', 120_000)], config)).toEqual([{ bucket, key: 'future', kind: 'verify' }])
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].count).toBe(0)
  }))

  it.concurrent('creates a batch of 100 ordinary legacy uploads and ignores duplicates without revision churn', () => fixture(async (db, bucket, event) => {
    const events = Array.from({ length: 100 }, (_, index) => event(`file-${index}`))
    expect(await applyInventoryEvents(db, events, config)).toEqual([])
    expect(await applyInventoryEvents(db, events, config)).toEqual([])
    const result = await db.query('SELECT count(*)::int AS count, max(revision)::int AS revision FROM public.r2_objects WHERE bucket_name = $1', [bucket])
    expect(result.rows[0]).toEqual({ count: 100, revision: 1 })
  }))
  it.concurrent('does not resurrect a deleted key with an older create, but accepts a newer replacement', () => fixture(async (db, bucket, event) => {
    await applyInventoryEvents(db, [event('key', 1000, 'deleted')], config)
    expect(await applyInventoryEvents(db, [event('key')], config)).toEqual([])
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('deleted')
    expect(await applyInventoryEvents(db, [event('key', 2000)], config)).toEqual([])
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('present')
  }))
  it.concurrent('verifies old missing events and equal-time conflicts without changing inventory', () => fixture(async (db, bucket, event) => {
    const old = event('old', -8 * 86400_000)
    expect(await applyInventoryEvents(db, [old], config)).toEqual([{ bucket, key: 'old', kind: 'verify' }])
    const create = event('conflict')
    const remove = event('conflict', 0, 'deleted')
    expect(await applyInventoryEvents(db, [create, remove], config)).toEqual([{ bucket, key: 'conflict', kind: 'verify' }])
    expect((await db.query('SELECT count(*)::int AS count FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].count).toBe(0)
    await applyInventoryEvents(db, [create], config)
    expect(await applyInventoryEvents(db, [remove], config)).toHaveLength(1)
  }))
  it.concurrent('never cancels committed deletion intent', () => fixture(async (db, bucket, event) => {
    await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state) VALUES ($1, 'key', 'to_be_deleted')`, [bucket])
    await applyInventoryEvents(db, [event('key')], config)
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('to_be_deleted')
    await applyInventoryEvents(db, [event('key', 1000, 'deleted')], config)
    await applyInventoryEvents(db, [event('key', 2000)], config)
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('to_be_deleted')
  }))
  it.concurrent('protects slow R2 observations with compare-and-swap revisions', () => fixture(async (db, bucket, event) => {
    await applyInventoryEvents(db, [event('key')], config)
    const snapshot = await readObservationSnapshot(db, bucket, ['key'])
    await applyInventoryEvents(db, [event('key', 1000, 'deleted')], config)
    const object = { key: 'key', size: 42, etag: 'etag', lastModified: new Date().toISOString() }
    expect(await applyObservations(db, bucket, snapshot, [{ key: 'key', object }], config)).toEqual(['key'])
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('deleted')
  }))
  it.concurrent('commits successful observations while returning only concurrently changed keys', () => fixture(async (db, bucket, event) => {
    await applyInventoryEvents(db, [event('healthy'), event('conflict')], config)
    const snapshot = await readObservationSnapshot(db, bucket, ['healthy', 'conflict'])
    await applyInventoryEvents(db, [event('conflict', 1000, 'deleted')], config)
    const object = { size: 84, etag: 'observed-etag', lastModified: new Date().toISOString() }
    expect(await applyObservations(db, bucket, snapshot, [
      { key: 'healthy', object: { ...object, key: 'healthy' } },
      { key: 'conflict', object: { ...object, key: 'conflict' } },
    ], config)).toEqual(['conflict'])
    const result = await db.query('SELECT r2_key, r2_state, size_bytes FROM public.r2_objects WHERE bucket_name = $1 ORDER BY r2_key', [bucket])
    expect(result.rows).toEqual([
      { r2_key: 'conflict', r2_state: 'deleted', size_bytes: '42' },
      { r2_key: 'healthy', r2_state: 'present', size_bytes: '84' },
    ])
  }))

  it.concurrent('rejects inserting over a key created after a missing-key observation', () => fixture(async (db, bucket, event) => {
    const snapshot = await readObservationSnapshot(db, bucket, ['key'])
    await applyInventoryEvents(db, [event('key')], config)
    expect(await applyObservations(db, bucket, snapshot, [{ key: 'key', object: null }], config)).toEqual(['key'])
  }))
  it.concurrent('uses current R2 observations to cover replay older than forgotten tombstones', () => fixture(async (db, bucket, event) => {
    const snapshot = await readObservationSnapshot(db, bucket, ['key'])
    expect(await applyObservations(db, bucket, snapshot, [{ key: 'key', object: null }], config)).toEqual([])
    expect(await applyInventoryEvents(db, [event('key', -8 * 86400_000)], config)).toEqual([])
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name = $1', [bucket])).rows[0].r2_state).toBe('deleted')
  }))
})
