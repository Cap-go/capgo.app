import type { ManifestSizeReceiptFacts } from '../supabase/functions/_backend/utils/manifest_size_receipt.ts'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { ManifestInventoryConflict, registerManifestInventory, reserveManifestPaths } from '../supabase/functions/_backend/utils/manifest_inventory.ts'
import { applyInventoryEvents, applyObservations, readObservationSnapshot } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { POSTGRES_URL } from './test-utils.ts'

async function fixture(run: (db: Client, second: Client, bucket: string) => Promise<void>) {
  const db = new Client({ connectionString: POSTGRES_URL })
  const second = new Client({ connectionString: POSTGRES_URL })
  const bucket = `manifest-inventory-${crypto.randomUUID()}`
  await Promise.all([db.connect(), second.connect()])
  try {
    await db.query(`INSERT INTO public.r2_inventory_checkpoints(bucket_name,job_name,accepted_event_floor) VALUES ($1,'admission',now()-interval '1 day')`, [bucket])
    await run(db, second, bucket)
  }
  finally {
    await db.query('DELETE FROM public.r2_objects WHERE bucket_name=$1', [bucket])
    await Promise.all([db.end(), second.end()])
  }
}
function facts(evidenceAt = Date.now() - 10_000): ManifestSizeReceiptFacts {
  return { version: 2, size: 42, signedAt: Date.now(), evidenceAt, source: 'r2_upload', uploadedAt: evidenceAt, etag: 'a'.repeat(32), etagHash: null, objectVersionHash: null, objectIdentity: null }
}
const reserve = (db: Client, bucket: string, suffixes = ['hash_file.js']) => reserveManifestPaths(db, bucket, 'delta/', suffixes, suffixes.map(() => 42))

describe('manifest inventory transactions', () => {
  it.concurrent('preserves present/pending states, reserves only usable keys and never shortens leases', () => fixture(async (db, second, bucket) => {
    const [a, b] = await Promise.all([reserve(db, bucket), reserve(second, bucket)])
    expect(a).toEqual(['hash_file.js'])
    expect(b).toEqual(a)
    await db.query(`UPDATE public.r2_objects SET r2_state='present',manifest_lease_expires_at=now()+interval '2 hours' WHERE bucket_name=$1`, [bucket])
    const before = await db.query('SELECT manifest_lease_expires_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])
    await reserve(db, bucket)
    const after = await db.query('SELECT r2_state,manifest_lease_expires_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])
    expect(after.rows[0].r2_state).toBe('present')
    expect(after.rows[0].manifest_lease_expires_at).toEqual(before.rows[0].manifest_lease_expires_at)
    await db.query(`UPDATE public.r2_objects SET r2_state='to_be_deleted' WHERE bucket_name=$1`, [bucket])
    expect(await reserve(db, bucket)).toEqual(['1/hash_file.js'])
    await db.query(`UPDATE public.r2_objects SET r2_state='deleted',tombstone_expires_at=now()+interval '7 days' WHERE bucket_name=$1 AND r2_key='delta/hash_file.js'`, [bucket])
    expect(await reserve(db, bucket)).toEqual(['1/hash_file.js'])
  }))

  it.concurrent('uses one bounded UUID attempt when all twenty candidates are retired', () => fixture(async (db, _second, bucket) => {
    await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state) SELECT $1,'delta/'||CASE WHEN n=0 THEN '' ELSE n||'/' END||'hash_file.js','to_be_deleted' FROM generate_series(0,19) n`, [bucket])
    expect(await reserveManifestPaths(db, bucket, 'delta/', ['hash_file.js'], [42], () => 'fake-uuid')).toEqual(['fake-uuid/hash_file.js'])
    await db.query(`UPDATE public.r2_objects SET r2_state='to_be_deleted' WHERE bucket_name=$1`, [bucket])
    await expect(reserveManifestPaths(db, bucket, 'delta/', ['hash_file.js'], [42], () => 'fake-uuid')).rejects.toBeInstanceOf(ManifestInventoryConflict)
  }))

  it.concurrent('registers recent facts without manufacturing an R2 notification and rejects the whole manifest on retirement', () => fixture(async (db, _second, bucket) => {
    await reserve(db, bucket)
    await registerManifestInventory(db, bucket, [{ path: 'delta/hash_file.js', facts: facts() }])
    const row = (await db.query('SELECT r2_state,last_event_at,last_reconciled_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]
    expect(row.r2_state).toBe('present')
    expect(row.last_event_at).toBeNull()
    expect(row.last_reconciled_at).not.toBeNull()
    await db.query(`UPDATE public.r2_objects SET r2_state='to_be_deleted' WHERE bucket_name=$1`, [bucket])
    await expect(registerManifestInventory(db, bucket, [{ path: 'new', facts: facts() }, { path: 'delta/hash_file.js', facts: facts() }])).rejects.toBeInstanceOf(ManifestInventoryConflict)
    expect((await db.query('SELECT count(*)::int n FROM public.r2_objects WHERE bucket_name=$1 AND r2_key=\'new\'', [bucket])).rows[0].n).toBe(0)
  }))

  it.concurrent('rejects expired reservations even with fresh receipts and rolls back every file', () => fixture(async (db, _second, bucket) => {
    const active = Array.from({ length: 500 }, (_, i) => `active-${i.toString().padStart(4, '0')}`)
    await reserve(db, bucket, [...active, 'expired'])
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=clock_timestamp() WHERE bucket_name=$1 AND r2_key='delta/expired'`, [bucket])
    const before = (await db.query('SELECT * FROM public.r2_objects WHERE bucket_name=$1 ORDER BY r2_key', [bucket])).rows
    await expect(registerManifestInventory(db, bucket, [
      ...active.map(key => ({ path: `delta/${key}`, facts: facts() })),
      { path: 'delta/expired', facts: facts() },
    ])).rejects.toMatchObject({ paths: ['delta/expired'] })
    expect((await db.query('SELECT * FROM public.r2_objects WHERE bucket_name=$1 ORDER BY r2_key', [bucket])).rows).toEqual(before)
  }))

  it.concurrent.each([false, true])('keeps the v2 reservation requirement when a path also has a v1 receipt (v2 first=%s)', v2First => fixture(async (db, _second, bucket) => {
    await reserve(db, bucket)
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=clock_timestamp() WHERE bucket_name=$1`, [bucket])
    const legacy = { ...facts(), version: 1 as const, evidenceAt: null, source: null, signedAt: null, uploadedAt: null }
    const entries = [{ path: 'delta/hash_file.js', facts: facts() }, { path: 'delta/hash_file.js', facts: legacy }]
    await expect(registerManifestInventory(db, bucket, v2First ? entries : entries.toReversed())).rejects.toBeInstanceOf(ManifestInventoryConflict)
  }))

  it.concurrent('rejects a reservation that expires while finalization waits for its row lock', ({ expect }) => fixture(async (db, second, bucket) => {
    await reserve(db, bucket)
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=clock_timestamp()+interval '1 second' WHERE bucket_name=$1`, [bucket])
    await db.query('BEGIN')
    let registering: Promise<unknown> | undefined
    try {
      await db.query(`SELECT 1 FROM public.r2_objects WHERE bucket_name=$1 FOR UPDATE`, [bucket])
      registering = registerManifestInventory(second, bucket, [{ path: 'delta/hash_file.js', facts: facts() }]).then(() => null, error => error)
      await expect.poll(async () => (await db.query(`SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [pid])).rows[0]?.wait_event_type).toBe('Lock')
      await db.query(`SELECT pg_sleep(greatest(0,extract(epoch FROM manifest_lease_expires_at-clock_timestamp()))::double precision+0.02) FROM public.r2_objects WHERE bucket_name=$1`, [bucket])
      await db.query('COMMIT')
      expect(await registering).toBeInstanceOf(ManifestInventoryConflict)
      expect((await db.query(`SELECT r2_state,manifest_lease_expires_at<=clock_timestamp() AS expired FROM public.r2_objects WHERE bucket_name=$1`, [bucket])).rows[0]).toEqual({ r2_state: 'to_be_uploaded', expired: true })
    }
    finally {
      await db.query('ROLLBACK')
      await registering
    }
  }))

  it.concurrent('requires a live v2 reservation even when a receipt is fresh or an expired placeholder was removed', () => fixture(async (db, _second, bucket) => {
    await reserve(db, bucket, ['removed'])
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=clock_timestamp() WHERE bucket_name=$1`, [bucket])
    await db.query('SELECT public.expire_r2_manifest_placeholders($1,1000)', [bucket])
    await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state) VALUES ($1,'delta/unreserved','present')`, [bucket])
    await expect(registerManifestInventory(db, bucket, ['missing', 'removed', 'unreserved'].map(key => ({ path: `delta/${key}`, facts: facts() })))).rejects.toMatchObject({ paths: ['delta/missing', 'delta/removed', 'delta/unreserved'] })
    expect((await db.query('SELECT r2_key,manifest_lease_expires_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows).toEqual([{ r2_key: 'delta/unreserved', manifest_lease_expires_at: null }])
  }))

  it.concurrent.each([false, true])('upload notifications preserve the existing reservation exactly (expired=%s)', expired => fixture(async (db, _second, bucket) => {
    await reserve(db, bucket)
    if (expired)
      await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=clock_timestamp() WHERE bucket_name=$1`, [bucket])
    const before = (await db.query(`SELECT to_char(manifest_lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM public.r2_objects WHERE bucket_name=$1`, [bucket])).rows[0].expires_at
    await applyInventoryEvents(db, [{ bucket, key: 'delta/hash_file.js', state: 'present', size: 42, etag: 'a'.repeat(32), eventTime: new Date().toISOString() }], { tombstoneDays: 7 })
    expect((await db.query(`SELECT r2_state,to_char(manifest_lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM public.r2_objects WHERE bucket_name=$1`, [bucket])).rows[0]).toEqual({ r2_state: 'present', expires_at: before })
    if (expired)
      await expect(registerManifestInventory(db, bucket, [{ path: 'delta/hash_file.js', facts: facts(Date.now()) }])).rejects.toBeInstanceOf(ManifestInventoryConflict)
    else
      await registerManifestInventory(db, bucket, [{ path: 'delta/hash_file.js', facts: facts(Date.now()) }])
  }))

  it.concurrent('rejects stale/equal/ambiguous evidence for deleted rows, accepts clearly newer evidence and ignores stale present metadata', () => fixture(async (db, _second, bucket) => {
    const boundary = Date.now() - 60_000
    await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state,last_event_at,last_reconciled_at,tombstone_expires_at,size_bytes,manifest_lease_expires_at)
      VALUES ($1,'key','deleted',to_timestamp($2 / 1000.0),to_timestamp($2 / 1000.0),now()+interval '7 days',84,now()+interval '30 minutes')`, [bucket, boundary])
    for (const delta of [-1000, 0, 4999, 5000])
      await expect(registerManifestInventory(db, bucket, [{ path: 'key', facts: facts(boundary + delta) }])).rejects.toBeInstanceOf(ManifestInventoryConflict)
    await registerManifestInventory(db, bucket, [{ path: 'key', facts: facts(boundary + 6000) }])
    expect((await db.query('SELECT r2_state,size_bytes FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]).toEqual({ r2_state: 'present', size_bytes: '42' })
    await db.query('UPDATE public.r2_objects SET size_bytes=84 WHERE bucket_name=$1', [bucket])
    await registerManifestInventory(db, bucket, [{ path: 'key', facts: facts(boundary) }])
    expect((await db.query('SELECT size_bytes FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0].size_bytes).toBe('84')
  }))

  it.concurrent('does not register missing old evidence or legacy facts and leaves legacy leases unchanged', () => fixture(async (db, _second, bucket) => {
    const legacy = { ...facts(), version: 1 as const, evidenceAt: null, source: null, signedAt: null, uploadedAt: null }
    await registerManifestInventory(db, bucket, [{ path: 'v1', facts: legacy }, { path: 'receiptless' }])
    expect((await db.query('SELECT count(*)::int n FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0].n).toBe(0)
    await expect(registerManifestInventory(db, bucket, [{ path: 'old', facts: facts(Date.now() - 8 * 86400_000) }])).rejects.toBeInstanceOf(ManifestInventoryConflict)
    await reserve(db, bucket)
    const before = (await db.query('SELECT revision,manifest_lease_expires_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]
    await registerManifestInventory(db, bucket, [{ path: 'delta/hash_file.js', facts: legacy }])
    expect((await db.query('SELECT revision,manifest_lease_expires_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]).toEqual(before)
  }))

  it.concurrent('expires only elapsed placeholders, retains other states/null/future leases and enforces the helper bound', () => fixture(async (db, _second, bucket) => {
    await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state,manifest_lease_expires_at)
      VALUES ($1,'elapsed','to_be_uploaded',now()),($1,'future','to_be_uploaded',now()+interval '1 hour'),($1,'null','to_be_uploaded',NULL),($1,'present','present',now()),($1,'retired','to_be_deleted',now())`, [bucket])
    expect((await db.query('SELECT public.expire_r2_manifest_placeholders($1,1000) n', [bucket])).rows[0].n).toBe(1)
    expect((await db.query('SELECT r2_key FROM public.r2_objects WHERE bucket_name=$1 ORDER BY r2_key', [bucket])).rows.map(row => row.r2_key)).toEqual(['future', 'null', 'present', 'retired'])
    await expect(db.query('SELECT public.expire_r2_manifest_placeholders($1,1001)', [bucket])).rejects.toThrow('Invalid placeholder expiry bound')
    expect((await db.query(`SELECT has_function_privilege('anon','public.expire_r2_manifest_placeholders(text,integer)','EXECUTE') allowed`)).rows[0].allowed).toBe(false)
  }))

  it.concurrent('serializes expiry behind consumer admission lock across its INSERT-then-SELECT gap', ({ expect }) => fixture(async (db, second, bucket) => {
    await reserve(db, bucket)
    await db.query('UPDATE public.r2_objects SET manifest_lease_expires_at=now() WHERE bucket_name=$1', [bucket])
    await db.query('BEGIN')
    try {
      await db.query(`SELECT 1 FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='admission' FOR SHARE`, [bucket])
      await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state) VALUES ($1,'delta/hash_file.js','present') ON CONFLICT DO NOTHING`, [bucket])
      let finished = false
      const expiring = second.query('SELECT public.expire_r2_manifest_placeholders($1,1000) n', [bucket]).then((result) => {
        finished = true
        return result
      })
      // A separate PG lock inspection proves blocking, not a timing-only sleep.
      const inspect = new Client({ connectionString: POSTGRES_URL })
      await inspect.connect()
      try {
        await expect.poll(async () => (await inspect.query(`SELECT count(*)::int n FROM pg_catalog.pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT public.expire_r2_manifest_placeholders%'`)).rows[0].n).toBeGreaterThan(0)
        expect(finished).toBe(false)
      }
      finally { await inspect.end() }
      await db.query(`SELECT 1 FROM public.r2_objects WHERE bucket_name=$1 AND r2_key='delta/hash_file.js' FOR UPDATE`, [bucket])
      await db.query(`UPDATE public.r2_objects SET r2_state='present' WHERE bucket_name=$1`, [bucket])
      await db.query('COMMIT')
      expect((await expiring).rows[0].n).toBe(0)
    }
    catch (error) {
      await db.query('ROLLBACK')
      throw error
    }
  }))

  it.concurrent('returns repair revision conflicts after expiry and preserves notifications after expiry', () => fixture(async (db, _second, bucket) => {
    await reserve(db, bucket)
    const snapshot = await readObservationSnapshot(db, bucket, ['delta/hash_file.js'])
    await db.query('UPDATE public.r2_objects SET manifest_lease_expires_at=now() WHERE bucket_name=$1', [bucket])
    await db.query('SELECT public.expire_r2_manifest_placeholders($1,1000)', [bucket])
    expect(await applyObservations(db, bucket, snapshot, [{ key: 'delta/hash_file.js', object: { key: 'delta/hash_file.js', size: 42, etag: 'fake', lastModified: new Date().toISOString() } }], { tombstoneDays: 7 })).toEqual(['delta/hash_file.js'])
    await applyInventoryEvents(db, [{ bucket, key: 'delta/hash_file.js', state: 'present', size: 42, etag: 'fake', eventTime: new Date().toISOString() }], { tombstoneDays: 7 })
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0].r2_state).toBe('present')
  }))
})

describe('manifest inventory production work bounds', () => {
  it.concurrent.each([5000, 10_000])('reserves and registers %i files with bounded chunks', count => fixture(async (db, _second, bucket) => {
    const startedAt = Date.now()
    const suffixes = Array.from({ length: count }, (_, i) => `file-${i}`)
    const reserved = await reserveManifestPaths(db, bucket, 'delta/', suffixes, suffixes.map(() => 42))
    await registerManifestInventory(db, bucket, reserved.map(path => ({ path: `delta/${path}`, facts: facts() })))
    expect((await db.query('SELECT count(*)::int n FROM public.r2_objects WHERE bucket_name=$1 AND r2_state=\'present\'', [bucket])).rows[0].n).toBe(count)
    expect(Date.now() - startedAt).toBeLessThan(20_000)
  }))
})

describe('manifest receipt and notification ordering', () => {
  it.concurrent('accepts matching ordinary notifications after receipt registration without scheduling per-file HEAD repair', () => fixture(async (db, _second, bucket) => {
    const evidenceAt = Date.now() - 10_000
    await reserveManifestPaths(db, bucket, '', ['new'], [42])
    await registerManifestInventory(db, bucket, [{ path: 'new', facts: facts(evidenceAt) }])
    expect(await applyInventoryEvents(db, [{ bucket, key: 'new', state: 'present', size: 42, etag: 'a'.repeat(32), eventTime: new Date(evidenceAt + 500).toISOString() }], { tombstoneDays: 7 })).toEqual([])
    expect((await db.query('SELECT r2_state,etag FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]).toEqual({ r2_state: 'present', etag: 'a'.repeat(32) })
  }))
})

describe('provider clock ambiguity', () => {
  it.concurrent('registers local read presence without advancing inventory metadata to a future provider clock', () => fixture(async (db, _second, bucket) => {
    await reserveManifestPaths(db, bucket, '', ['read'], [42])
    await registerManifestInventory(db, bucket, [{ path: 'read', facts: { ...facts(), source: 'r2_read', uploadedAt: Date.now() + 60_000 } }])
    const row = (await db.query('SELECT r2_state,last_reconciled_at,r2_last_modified_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]
    expect(row.r2_state).toBe('present')
    expect(row.last_reconciled_at).not.toBeNull()
    expect(row.r2_last_modified_at).toBeNull()
  }))
})

describe('parallel reservation retirement', () => {
  it.concurrent('rechecks eight blocked reservations after retirement while an indexed control query remains responsive', ({ expect }) => fixture(async (db, second, bucket) => {
    await reserve(db, bucket)
    const peers = [second, ...Array.from({ length: 7 }, () => new Client({ connectionString: POSTGRES_URL }))]
    const inspect = new Client({ connectionString: POSTGRES_URL })
    await Promise.all([...peers.slice(1).map(peer => peer.connect()), inspect.connect()])
    await db.query('BEGIN')
    try {
      await db.query(`UPDATE public.r2_objects SET r2_state='to_be_deleted' WHERE bucket_name=$1`, [bucket])
      const results = peers.map(peer => reserve(peer, bucket))
      await expect.poll(async () => (await inspect.query(`SELECT count(*)::int n FROM pg_catalog.pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO public.r2_objects AS target%'`)).rows[0].n).toBeGreaterThanOrEqual(8)
      const controlStarted = Date.now()
      expect((await inspect.query('SELECT bucket_name FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 LIMIT 1', [bucket])).rows[0].bucket_name).toBe(bucket)
      expect(Date.now() - controlStarted).toBeLessThan(5000)
      await db.query('COMMIT')
      expect(await Promise.all(results)).toEqual(peers.map(() => ['1/hash_file.js']))
      expect((await inspect.query('SELECT r2_state,cleanup_requested_at FROM public.r2_objects WHERE bucket_name=$1 AND r2_key=\'delta/hash_file.js\'', [bucket])).rows[0]).toMatchObject({ r2_state: 'to_be_deleted', cleanup_requested_at: expect.any(Date) })
    }
    finally {
      await db.query('ROLLBACK')
      await Promise.all([...peers.slice(1).map(peer => peer.end()), inspect.end()])
    }
  }))
})
