import type { CleanupMessage } from '../cloudflare_workers/r2_inventory/cleanup.ts'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { claimCleanupAlert } from '../cloudflare_workers/r2_inventory/cleanup_alerts.ts'
import { completeCleanupGroup, inspectCleanupGroup } from '../cloudflare_workers/r2_inventory/cleanup_database.ts'
import { applyInventoryEvents, INVENTORY_CONFIG, readObservationSnapshot } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { POSTGRES_URL } from './test-utils.ts'

async function fixture(work: (db: Client, peer: Client, bucket: string, key: string) => Promise<void>) {
  const db = new Client({ connectionString: POSTGRES_URL })
  const peer = new Client({ connectionString: POSTGRES_URL })
  const bucket = `consumer-test-${crypto.randomUUID()}`
  const key = `orgs/${bucket}/apps/com.test.cleanup/delta/file`
  await Promise.all([db.connect(), peer.connect()])
  try {
    await db.query(`INSERT INTO public.r2_inventory_checkpoints(bucket_name,job_name,checkpoint)
      VALUES ($1,'cleanup_health',jsonb_build_object('schemaVersion',1,'observedAt',clock_timestamp(),
      'manifestReplicationHealthy',true,'deletionBacklog',99999999,'notificationsHealthy',false,'repairsHealthy',false,'deletionConsumerHealthy',false))`, [bucket])
    await work(db, peer, bucket, key)
  }
  finally {
    await db.query('ROLLBACK')
    await peer.query('ROLLBACK')
    await peer.query('SET session_replication_role=replica')
    await peer.query('DELETE FROM public.manifest WHERE starts_with(s3_path,$1)', [key])
    await peer.query('DELETE FROM public.r2_objects WHERE bucket_name=$1', [bucket])
    await peer.query(`DELETE FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name <> 'admission'`, [bucket])
    await Promise.all([db.end(), peer.end()])
  }
}
async function seed(db: Client, bucket: string, key: string): Promise<CleanupMessage> {
  const result = await db.query(`INSERT INTO public.r2_objects(bucket_name,r2_key,r2_state,size_bytes,etag,last_event_at,r2_last_modified_at)
    VALUES ($1,$2,'to_be_deleted',42,'original-etag',now()-interval '2 hours',now()-interval '2 hours')
    RETURNING to_char(cleanup_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp`, [bucket, key])
  return { schemaVersion: 1, bucket, key, cleanupRequestedAt: result.rows[0].stamp }
}
async function decision(db: Client, bucket: string, job: CleanupMessage) {
  return (await inspectCleanupGroup(db, bucket, [job])).decisions.get(job)
}

describe('cleanup consumer committed Postgres safety', () => {
  it.concurrent('requires committed exact microsecond retirement; handles extraneous, old and completed jobs independently', () => fixture(async (db, peer, bucket, key) => {
    await db.query('BEGIN')
    const job = await seed(db, bucket, key)
    expect(await decision(peer, bucket, job)).toBe('retry')
    await db.query('ROLLBACK')
    expect(await decision(peer, bucket, job)).toBe('retry')
    const actual = await seed(db, bucket, key)
    expect(actual.cleanupRequestedAt).not.toBe(job.cleanupRequestedAt)
    expect(await decision(peer, bucket, job)).toBe('obsolete')
    expect(await decision(peer, bucket, actual)).toBe('remove')
    const fraction = actual.cleanupRequestedAt.slice(-7, -1)
    const changed = Number(fraction) + (fraction.endsWith('9') ? -1 : 1)
    const microsecondMismatch = { ...actual, cleanupRequestedAt: `${actual.cleanupRequestedAt.slice(0, -7) + String(changed).padStart(6, '0')}Z` }
    expect(new Date(microsecondMismatch.cleanupRequestedAt).getTime()).toBe(new Date(actual.cleanupRequestedAt).getTime())
    expect(await decision(peer, bucket, microsecondMismatch)).toBe('obsolete')
    const inspection = await inspectCleanupGroup(peer, bucket, [actual, job])
    expect(inspection.decisions.get(actual)).toBe('remove')
    expect(inspection.decisions.get(job)).toBe('obsolete')
    await db.query(`UPDATE public.r2_objects SET r2_state='deleted',tombstone_expires_at=now()+interval '7 days' WHERE bucket_name=$1`, [bucket])
    expect(await decision(peer, bucket, actual)).toBe('completed')
  }))

  it.concurrent('keeps a reference or active lease retired while allowing an exact non-reference peer', () => fixture(async (db, _peer, bucket, key) => {
    const jobs = [await seed(db, bucket, key), await seed(db, bucket, `${key}-leased`), await seed(db, bucket, `${key}-peer`)]
    await db.query('BEGIN')
    await db.query('SET LOCAL session_replication_role=replica')
    await db.query(`INSERT INTO public.manifest(app_version_id,file_name,s3_path,file_hash) VALUES(-1,$1,$1,'synthetic')`, [key])
    await db.query('COMMIT')
    await db.query(`UPDATE public.r2_objects SET manifest_lease_expires_at=now()+interval '1 hour' WHERE bucket_name=$1 AND r2_key=$2`, [bucket, `${key}-leased`])
    const inspected = await inspectCleanupGroup(db, bucket, jobs)
    expect(jobs.map(job => inspected.decisions.get(job))).toEqual(['referenced', 'leased', 'remove'])
    const rows = await db.query(`SELECT r2_state,cleanup_requested_at IS NOT NULL retired FROM public.r2_objects WHERE bucket_name=$1`, [bucket])
    expect(rows.rows.every(row => row.r2_state === 'to_be_deleted' && row.retired)).toBe(true)
  }))

  it.concurrent.each([
    { observedAt: 'invalid' },
    { observedAt: '2026-02-30T00:00:00Z' },
    { schemaVersion: 4 },
    { schemaVersion: '3' },
    { manifestReplicationHealthy: false },
  ])('fails closed on invalid replication evidence %j', patch => fixture(async (db, _peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||$2::jsonb WHERE bucket_name=$1`, [bucket, JSON.stringify(patch)])
    await expect(inspectCleanupGroup(db, bucket, [job])).rejects.toThrow()
  }))

  it.concurrent('accepts replication evidence older than producer bound, rejects missing, future and more than five minutes', () => fixture(async (db, _peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object('observedAt',clock_timestamp()-interval '240 seconds') WHERE bucket_name=$1`, [bucket])
    expect(await decision(db, bucket, job)).toBe('remove')
    for (const seconds of [-60, 301]) {
      await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object('observedAt',clock_timestamp()-$2::int*interval '1 second') WHERE bucket_name=$1`, [bucket, seconds])
      await expect(inspectCleanupGroup(db, bucket, [job])).rejects.toThrow('replication evidence')
    }
    await db.query(`DELETE FROM public.r2_inventory_checkpoints WHERE bucket_name=$1`, [bucket])
    await expect(inspectCleanupGroup(db, bucket, [job])).rejects.toThrow('replication evidence')
  }))

  it.concurrent('accepts the upstream v2 health checkpoint without adopting producer-only flags or its freshness limit', () => fixture(async (db, _peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object(
      'schemaVersion',2,'healthy',false,'producerReady',false,'maxAgeSeconds',120,
      'observedAt',clock_timestamp()-interval '240 seconds') WHERE bucket_name=$1`, [bucket])
    expect(await decision(db, bucket, job)).toBe('remove')
  }))

  it.concurrent('accepts replication-only v3 health and preserves the consumer replication safety checks', () => fixture(async (db, _peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    const checkpoint = { schemaVersion: 3, healthy: true, checkedAt: Date.now(), observedAt: new Date(Date.now() - 240_000).toISOString(), maxAgeSeconds: 120, manifestReplicationHealthy: true, reasons: [] }
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=$2::jsonb WHERE bucket_name=$1`, [bucket, JSON.stringify(checkpoint)])
    expect(await decision(db, bucket, job)).toBe('remove')
    for (const patch of [{ manifestReplicationHealthy: false }, { observedAt: new Date(Date.now() - 301_000).toISOString() }]) {
      await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=$2::jsonb WHERE bucket_name=$1`, [bucket, JSON.stringify({ ...checkpoint, ...patch })])
      await expect(inspectCleanupGroup(db, bucket, [job])).rejects.toThrow('replication evidence')
    }
  }))

  it.concurrent('refuses RLS-hidden manifest reads rather than interpreting them as absence', () => fixture(async (db, peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    // Existing authenticated role cannot bypass manifest RLS. Its real policy
    // must error with row_security=off, even when no matching row is visible.
    await peer.query('BEGIN')
    await peer.query('SET LOCAL ROLE authenticated')
    await peer.query('SET LOCAL row_security=off')
    await expect(peer.query('SELECT s3_path FROM public.manifest WHERE s3_path=$1', [key])).rejects.toThrow()
    await peer.query('ROLLBACK')
    expect(await decision(db, bucket, job)).toBe('remove')
  }))

  it.concurrent('completes absence with revision/watermark CAS, preserves metadata and permanent retirement without eventTime', () => fixture(async (db, peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    const inspected = await inspectCleanupGroup(db, bucket, [job])
    expect(await completeCleanupGroup(peer, bucket, inspected.snapshot, [key])).toEqual([])
    const row = (await db.query(`SELECT r2_state,size_bytes,etag,last_event_at,last_reconciled_at,
      to_char(cleanup_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') retired FROM public.r2_objects WHERE bucket_name=$1`, [bucket])).rows[0]
    expect(row).toMatchObject({ r2_state: 'deleted', size_bytes: '42', etag: 'original-etag', retired: job.cleanupRequestedAt })
    expect(row.last_reconciled_at.toISOString()).toBe(new Date(inspected.snapshot.startedAt).toISOString())
    expect(row.last_event_at.getTime()).toBeLessThan(Date.now() - 3600000)
    await expect(db.query(`UPDATE public.r2_objects SET r2_state='present',tombstone_expires_at=NULL,cleanup_requested_at=NULL WHERE bucket_name=$1`, [bucket])).rejects.toThrow('cannot be reversed')
  }))

  it.concurrent('never overwrites a concurrent notification; fresh later completion preserves its metadata/event watermark', () => fixture(async (db, peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    const before = await inspectCleanupGroup(db, bucket, [job])
    await applyInventoryEvents(peer, [{ bucket, key, state: 'present', eventTime: new Date().toISOString(), size: 99, etag: 'new-event' }], INVENTORY_CONFIG)
    expect(await completeCleanupGroup(db, bucket, before.snapshot, [key])).toEqual([key])
    const after = await readObservationSnapshot(db, bucket, [key])
    expect(await completeCleanupGroup(db, bucket, after, [key])).toEqual([])
    const row = (await db.query('SELECT etag,size_bytes,r2_state,last_event_at FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0]
    expect(row).toMatchObject({ etag: 'new-event', size_bytes: '99', r2_state: 'deleted' })
    expect(row.last_event_at).toBeInstanceOf(Date)
  }))

  it.concurrent('bounds lock contention and rejects expired observations without turning completion failure into storage retry', () => fixture(async (db, peer, bucket, key) => {
    const job = await seed(db, bucket, key)
    const inspection = await inspectCleanupGroup(db, bucket, [job])
    await peer.query('BEGIN')
    await peer.query('SELECT 1 FROM public.r2_objects WHERE bucket_name=$1 FOR UPDATE', [bucket])
    await expect(completeCleanupGroup(db, bucket, inspection.snapshot, [key])).rejects.toThrow()
    await peer.query('ROLLBACK')
    expect((await db.query('SELECT r2_state FROM public.r2_objects WHERE bucket_name=$1', [bucket])).rows[0].r2_state).toBe('to_be_deleted')
    inspection.snapshot.startedAt = new Date(Date.now() - 121000).toISOString()
    await expect(completeCleanupGroup(db, bucket, inspection.snapshot, [key])).rejects.toThrow('expired')
  }))
})

describe('durable cleanup alert cooldown', () => {
  it.concurrent('allows one global claim across overlapping invocations and accumulates suppressed generic counts', () => fixture(async (db, peer, bucket) => {
    const results = await Promise.all([claimCleanupAlert(db, bucket, { storage: 3 }), claimCleanupAlert(peer, bucket, { referenced: 2 })])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await claimCleanupAlert(db, bucket, { storage: 4 })).toBeNull()
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object('nextAllowedAt',clock_timestamp()-interval '1 second') WHERE bucket_name=$1 AND job_name='cleanup_discord_alert'`, [bucket])
    const next = await claimCleanupAlert(peer, bucket, { completion: 1 })
    expect(next?.counts.completion).toBe(1)
    expect((results.find(Boolean)!.counts.storage ?? 0) + (next!.counts.storage ?? 0)).toBe(7)
    expect((results.find(Boolean)!.counts.referenced ?? 0) + (next!.counts.referenced ?? 0)).toBe(2)
    expect(next!.token).not.toBe(results.find(Boolean)!.token)
  }))
})
