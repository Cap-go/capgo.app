import type { ClientBase, QueryConfig } from 'pg'
import type { CleanupLease, CleanupMessage, CleanupQueue } from '../cloudflare_workers/r2_inventory/cleanup.ts'
import type { CleanupHealth } from '../cloudflare_workers/r2_inventory/health.ts'
import { Client } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { acquireCleanupLease, CLEANUP_CONFIG, discoverCleanupPage, releaseCleanupLease, retireCleanupRange, runCleanupProducer } from '../cloudflare_workers/r2_inventory/cleanup.ts'
import { reserveManifestPaths } from '../supabase/functions/_backend/utils/manifest_inventory.ts'
import { POSTGRES_URL } from './test-utils.ts'

async function fixture(run: (db: Client, peer: Client, bucket: string, prefix: string) => Promise<void>) {
  const db = new Client({ connectionString: POSTGRES_URL })
  const peer = new Client({ connectionString: POSTGRES_URL })
  const bucket = `cleanup-test-${crypto.randomUUID()}`
  const prefix = `orgs/${bucket}/apps/com.test.cleanup/delta/`
  await Promise.all([db.connect(), peer.connect()])
  try {
    await run(db, peer, bucket, prefix)
  }
  finally {
    // Replica-shaped fixture rows may have synthetic parent ids. Bypass only on
    // this test connection, never disable a shared table's triggers globally.
    await peer.query(`SET session_replication_role = replica`)
    await peer.query('DELETE FROM public.manifest WHERE starts_with(s3_path,$1)', [prefix])
    await peer.query('DELETE FROM public.r2_objects WHERE bucket_name=$1', [bucket])
    await peer.query(`DELETE FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name <> 'admission'`, [bucket])
    await Promise.all([db.end(), peer.end()])
  }
}

async function seed(db: Client, bucket: string, keys: string[]) {
  await db.query('BEGIN')
  try {
    await db.query('SET LOCAL session_replication_role = replica')
    await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state,first_seen_at,last_event_at)
      SELECT $1,key,'present',now()-interval '2 hours',now()-interval '2 hours' FROM unnest($2::text[]) key`, [bucket, keys])
    await db.query('COMMIT')
  }
  catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}
async function reference(db: Client, key: string) {
  await db.query('BEGIN')
  try {
    await db.query('SET LOCAL session_replication_role = replica')
    await db.query(`INSERT INTO public.manifest(app_version_id,file_name,s3_path,file_hash) VALUES (-1,$1,$1,'synthetic-hash')`, [key])
    await db.query('COMMIT')
  }
  catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}
async function lease(db: Client, bucket: string): Promise<CleanupLease> {
  const result = await acquireCleanupLease(db, bucket, crypto.randomUUID())
  expect(result).not.toBeNull()
  return result!
}
const directHealth = (): CleanupHealth => ({ schemaVersion: 3, healthy: true, checkedAt: Date.now(), observedAt: new Date().toISOString(), maxAgeSeconds: 120, manifestReplicationHealthy: true, reasons: [] })
const queue = () => ({ sendBatch: vi.fn().mockResolvedValue(undefined) })
const retire = (db: ClientBase, bucket: string, run: CleanupLease, keys: string[], cursor: string, q: CleanupQueue) => retireCleanupRange(db, bucket, run, keys, cursor, q, Date.now() + CLEANUP_CONFIG.runMs, directHealth())
async function checkpoint(db: Client, bucket: string) {
  return (await db.query(`SELECT checkpoint FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='cleanup_producer'`, [bucket])).rows[0].checkpoint
}

describe('cleanup producer Postgres transactions', () => {
  it.concurrent('keeps producing without a cleanup backlog cap', () => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    const q = queue()
    const health = { ...directHealth(), deletionBacklog: 1_000_000 }
    expect(await runCleanupProducer(db, bucket, q, health)).toBe(1)
    expect(q.sendBatch).toHaveBeenCalledOnce()
    expect((await peer.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0].r2_state).toBe('to_be_deleted')
  }))

  it.concurrent('bounds discovery to examined keys and rejects leases, references, unknown/recent age, non-delta/trash/ZIP and retired rows', () => fixture(async (db, _peer, bucket, prefix) => {
    const names = ['eligible', 'expired', 'leased', 'referenced', 'unknown', 'recent-event', 'recent-modified', 'recent-first', 'retired', 'trash/file', 'file.zip', '../file', 'double//file']
    await seed(db, bucket, [...names.map(n => prefix + n), `${prefix.replace('/delta/', '/bundles/')}bundle.zip`])
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=CASE WHEN r2_key=$2 THEN now()+interval '1 hour' ELSE now()-interval '1 second' END WHERE bucket_name=$1 AND r2_key=ANY($3::text[])`, [bucket, `${prefix}leased`, [`${prefix}leased`, `${prefix}expired`]])
    await reference(db, `${prefix}referenced`)
    await db.query(`UPDATE public.r2_objects SET last_event_at=NULL WHERE bucket_name=$1 AND r2_key=$2`, [bucket, `${prefix}unknown`])
    await db.query(`UPDATE public.r2_objects SET last_event_at=now() WHERE bucket_name=$1 AND r2_key=$2`, [bucket, `${prefix}recent-event`])
    await db.query(`UPDATE public.r2_objects SET r2_last_modified_at=now() WHERE bucket_name=$1 AND r2_key=$2`, [bucket, `${prefix}recent-modified`])
    await db.query(`UPDATE public.r2_objects SET r2_state='to_be_deleted' WHERE bucket_name=$1 AND r2_key=$2`, [bucket, `${prefix}retired`])
    await db.query('SET session_replication_role = replica')
    await db.query(`UPDATE public.r2_objects SET first_seen_at=now() WHERE bucket_name=$1 AND r2_key=$2`, [bucket, `${prefix}recent-first`])
    await db.query('SET session_replication_role = origin')
    const page = await discoverCleanupPage(db, bucket, '')
    expect(page).toHaveLength(14)
    expect(page.filter(r => r.eligible).map(r => r.r2_key)).toEqual([`${prefix}eligible`, `${prefix}expired`])
    const q = queue()
    expect(await retire(db, bucket, await lease(db, bucket), page.map(r => r.r2_key), page.at(-1)!.r2_key, q)).toBe(2)
    expect(q.sendBatch.mock.calls[0][0]).toHaveLength(2)
  }))

  it.concurrent('uses exact indexed manifest references and rechecks a reference committed after discovery', () => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    await reference(peer, `${key}-other`)
    expect((await discoverCleanupPage(db, bucket, ''))[0].eligible).toBe(true)
    await reference(peer, key)
    const q = queue()
    expect(await retire(db, bucket, await lease(db, bucket), [key], key, q)).toBe(0)
    expect(q.sendBatch).not.toHaveBeenCalled()
    expect((await checkpoint(db, bucket)).cursor).toBe(key)
  }))

  it.concurrent('preserves a concurrently committed reservation that wins the row lock', ({ expect }) => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    const run = await lease(db, bucket)
    expect((await discoverCleanupPage(db, bucket, ''))[0].eligible).toBe(true)
    await peer.query('BEGIN')
    await peer.query('SELECT 1 FROM public.r2_objects WHERE bucket_name=$1 AND r2_key=$2 FOR UPDATE', [bucket, key])
    const q = queue()
    const retiring = retire(db, bucket, run, [key], key, q)
    const inspect = new Client({ connectionString: POSTGRES_URL })
    await inspect.connect()
    try {
      await expect.poll(async () => (await inspect.query(`SELECT count(*)::int n FROM pg_catalog.pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT r2_key FROM public.r2_objects%'`)).rows[0].n, { interval: 10, timeout: 400 }).toBeGreaterThan(0)
      await peer.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=now()+interval '30 minutes' WHERE bucket_name=$1 AND r2_key=$2`, [bucket, key])
      await peer.query('COMMIT')
      expect(await retiring).toBe(0)
      expect(q.sendBatch).not.toHaveBeenCalled()
    }
    finally {
      await peer.query('ROLLBACK')
      await inspect.end()
    }
  }))

  it.concurrent('retirement wins against subsequent reservations and never reuses the physical key', () => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    await retire(db, bucket, await lease(db, bucket), [key], key, queue())
    expect(await reserveManifestPaths(peer, bucket, prefix, ['file'], [42])).toEqual(['1/file'])
    await db.query(`UPDATE public.r2_objects SET r2_state='deleted',tombstone_expires_at=now()+interval '7 days' WHERE bucket_name=$1 AND r2_key=$2`, [bucket, key])
    await expect(db.query(`UPDATE public.r2_objects SET r2_state='present',tombstone_expires_at=NULL WHERE bucket_name=$1 AND r2_key=$2`, [bucket, key])).rejects.toThrow('cannot be reversed')
    const q = queue()
    await runCleanupProducer(db, bucket, q, directHealth())
    expect(q.sendBatch).not.toHaveBeenCalled()
  }))

  it.concurrent('allows only one lease, expires crashes and fences the old owner before publication or cursor advancement', () => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    const first = await lease(db, bucket)
    expect(await acquireCleanupLease(peer, bucket, 'second')).toBeNull()
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object('leaseUntil',now()-interval '1 second') WHERE bucket_name=$1 AND job_name='cleanup_producer'`, [bucket])
    const second = await lease(peer, bucket)
    expect(BigInt(second.fence)).toBe(BigInt(first.fence) + 1n)
    const q = queue()
    await expect(retire(db, bucket, first, [key], key, q)).rejects.toThrow('lease lost')
    await releaseCleanupLease(db, bucket, first)
    expect((await checkpoint(peer, bucket)).owner).toBe(second.owner)
    expect((await checkpoint(peer, bucket)).cursor).toBe('')
    expect(q.sendBatch).not.toHaveBeenCalled()
  }))

  it.concurrent('holds the fence lock through publication, then rejects expired ownership instead of committing', () => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    const run = await lease(db, bucket)
    const q = { sendBatch: vi.fn(async () => {
      await peer.query(`SET lock_timeout='100ms'`)
      await expect(acquireCleanupLease(peer, bucket, 'overlap')).rejects.toThrow('lock timeout')
      await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object('leaseUntil',now()-interval '1 second') WHERE bucket_name=$1 AND job_name='cleanup_producer'`, [bucket])
    }) }
    await expect(retire(db, bucket, run, [key], key, q as CleanupQueue)).rejects.toThrow('expired before commit')
    expect((await checkpoint(peer, bucket)).cursor).toBe('')
    expect((await peer.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0].r2_state).toBe('present')
  }))

  it.concurrent('awaits publication before commit and emits the database microsecond retirement identity, never revision', () => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    let published: CleanupMessage | undefined
    const q = { sendBatch: vi.fn(async (batch: MessageSendRequest<CleanupMessage>[], options: QueueSendBatchOptions) => {
      expect(options).toEqual({ delaySeconds: 30 })
      published = batch[0].body
      expect(published).toMatchObject({ schemaVersion: 1, bucket, key, cleanupRequestedAt: expect.stringMatching(/\.\d{6}Z$/) })
      expect(published).not.toHaveProperty('revision')
      expect((await peer.query('SELECT r2_state,cleanup_requested_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]).toEqual({ r2_state: 'present', cleanup_requested_at: null })
    }) }
    expect(await retire(db, bucket, await lease(db, bucket), [key], key, q as CleanupQueue)).toBe(1)
    const result = await peer.query(`SELECT to_char(cleanup_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp FROM public.r2_objects WHERE bucket_name=$1`, [bucket])
    expect(result.rows[0].stamp).toBe(published!.cleanupRequestedAt)
    expect((await checkpoint(peer, bucket)).cursor).toBe(key)
  }))

  it.concurrent.each(['reject', 'ambiguous-timeout'])('rolls back retirement/cursor after %s; extraneous messages cannot authorize R2 work', mode => fixture(async (db, peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    const run = await lease(db, bucket)
    let accept: () => void = () => {}
    let old: CleanupMessage | undefined
    const q = { sendBatch: vi.fn(async (batch: MessageSendRequest<CleanupMessage>[]) => {
      old = batch[0].body
      if (mode === 'reject')
        throw new Error('Synthetic publication failure')
      await new Promise<void>((resolve) => {
        accept = resolve
      })
    }) }
    await expect(retire(db, bucket, run, [key], key, q as CleanupQueue)).rejects.toThrow(mode === 'reject' ? 'publication failure' : 'acceptance is ambiguous')
    accept() // Accepted after rollback: sendBatch has no cancellation API.
    expect((await peer.query('SELECT r2_state,cleanup_requested_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]).toEqual({ r2_state: 'present', cleanup_requested_at: null })
    expect((await checkpoint(peer, bucket)).cursor).toBe('')
    const good = queue()
    await retire(db, bucket, run, [key], key, good)
    expect(good.sendBatch.mock.calls[0][0][0].body.cleanupRequestedAt).not.toBe(old!.cleanupRequestedAt)
  }))

  it.concurrent('keeps committed batches and resumes the unfinished range after a later publication fails', () => fixture(async (db, _peer, bucket, prefix) => {
    await seed(db, bucket, Array.from({ length: 205 }, (_, i) => prefix + String(i).padStart(4, '0')))
    const q = queue()
    q.sendBatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Second batch unavailable'))
    await expect(runCleanupProducer(db, bucket, q, directHealth())).rejects.toThrow('Second batch unavailable')
    expect((await checkpoint(db, bucket)).cursor).toBe(`${prefix}0099`)
    expect((await db.query(`SELECT count(*)::int n FROM public.r2_objects WHERE bucket_name=$1 AND r2_state='to_be_deleted'`, [bucket])).rows[0].n).toBe(100)
    const retry = queue()
    expect(await runCleanupProducer(db, bucket, retry, directHealth())).toBe(105)
    expect(retry.sendBatch.mock.calls.flatMap(call => call[0].map((item: MessageSendRequest<CleanupMessage>) => item.body.key))).not.toContain(`${prefix}0099`)
    expect((await checkpoint(db, bucket)).cursor).toBe('')
  }))

  it.concurrent('does not start another byte-split send when the first resolves after rollback', () => fixture(async (db, peer, bucket, prefix) => {
    const keys = Array.from({ length: 100 }, (_, i) => `${prefix}${i}-${'\u0001'.repeat(800)}`)
    await seed(db, bucket, keys)
    let accept: () => void = () => {}
    const q = { sendBatch: vi.fn(async () => {
      await new Promise<void>((resolve) => {
        accept = resolve
      })
    }) }
    await expect(retire(db, bucket, await lease(db, bucket), keys, keys.at(-1)!, q)).rejects.toThrow('acceptance is ambiguous')
    accept()
    await new Promise(resolve => setImmediate(resolve))
    expect(q.sendBatch).toHaveBeenCalledTimes(1)
    expect((await checkpoint(peer, bucket)).cursor).toBe('')
    expect((await peer.query(`SELECT count(*)::int n FROM public.r2_objects WHERE bucket_name=$1 AND r2_state='present' AND cleanup_requested_at IS NULL`, [bucket])).rows[0].n).toBe(100)
  }))

  it.concurrent('does not proceed past ambiguous commit; reloads committed progress without redispatching retired rows', () => fixture(async (db, _peer, bucket, prefix) => {
    await seed(db, bucket, Array.from({ length: 101 }, (_, i) => prefix + String(i).padStart(4, '0')))
    let failed = false
    const wrapped = { query: async (statement: string | QueryConfig, values?: unknown[]) => {
      const result = await db.query(statement as string, values)
      if (!failed && (typeof statement === 'string' ? statement : statement.text).toLowerCase() === 'commit') {
        failed = true
        throw new Error('Synthetic lost commit response')
      }
      return result
    } }
    const q = queue()
    await expect(runCleanupProducer(wrapped as unknown as ClientBase, bucket, q, directHealth())).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'Synthetic lost commit response' }) })
    expect(q.sendBatch).toHaveBeenCalledTimes(1)
    expect((await checkpoint(db, bucket)).cursor).toBe(`${prefix}0099`)
    expect(await runCleanupProducer(db, bucket, queue(), directHealth())).toBe(1)
  }))

  it.concurrent('advances a full zero-result page, wraps, and revisits behind-cursor/previously leased keys', () => fixture(async (db, _peer, bucket, prefix) => {
    const keys = Array.from({ length: 10_001 }, (_, i) => prefix + String(i).padStart(5, '0'))
    await seed(db, bucket, keys)
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=now()+interval '1 hour' WHERE bucket_name=$1`, [bucket])
    expect(await discoverCleanupPage(db, bucket, '')).toHaveLength(10_000)
    const q = queue()
    let pages = 0
    const interrupted = { query: async (statement: string | QueryConfig, values?: unknown[]) => {
      if (typeof statement === 'string' && statement.startsWith('WITH page AS MATERIALIZED') && ++pages === 2)
        throw new Error('Synthetic interrupted zero-result scan')
      return db.query(statement as string, values)
    } }
    await expect(runCleanupProducer(interrupted as unknown as ClientBase, bucket, q, directHealth())).rejects.toThrow('interrupted zero-result scan')
    // This is the last examined key of the first page, despite zero retirements.
    expect((await checkpoint(db, bucket)).cursor).toBe(keys[9999])
    expect(await runCleanupProducer(db, bucket, q, directHealth())).toBe(0)
    expect(q.sendBatch).not.toHaveBeenCalled()
    expect((await checkpoint(db, bucket)).cursor).toBe('')
    await seed(db, bucket, [`${prefix}!behind`])
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=now()-interval '1 second' WHERE bucket_name=$1 AND r2_key=$2`, [bucket, keys[0]])
    expect(await runCleanupProducer(db, bucket, q, directHealth())).toBe(2)
  }))

  it.concurrent('stops before publication when budget or health becomes unsafe without advancing unfinished work', () => fixture(async (db, _peer, bucket, prefix) => {
    const key = `${prefix}file`
    await seed(db, bucket, [key])
    const run = await lease(db, bucket)
    const q = queue()
    await expect(retireCleanupRange(db, bucket, run, [key], key, q, Date.now(), directHealth())).rejects.toThrow('budget exhausted')
    await expect(retireCleanupRange(db, bucket, run, [key], key, q, Date.now() + CLEANUP_CONFIG.runMs, { ...directHealth(), healthy: false })).rejects.toThrow('health check')
    expect(q.sendBatch).not.toHaveBeenCalled()
    expect((await checkpoint(db, bucket)).cursor).toBe('')
  }))
})
