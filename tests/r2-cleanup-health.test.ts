import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { checkCleanupHealth, DESTINATION_HEALTH_SQL, REPLICATION, SOURCE_HEALTH_SQL } from '../cloudflare_workers/r2_inventory/health.ts'
import { POSTGRES_URL } from './test-utils.ts'

async function fixture(run: (inventory: Client, peer: Client, bucket: string, check: () => ReturnType<typeof checkCleanupHealth>) => Promise<void>) {
  const source = new Client({ connectionString: POSTGRES_URL })
  const inventory = new Client({ connectionString: POSTGRES_URL })
  const peer = new Client({ connectionString: POSTGRES_URL })
  const bucket = `health-test-${crypto.randomUUID()}`
  // Metadata SQL is separately validated on the live publisher/subscriber.
  // Keep transactions, checkpoint writes, locks and connection cancellation real.
  const query = (client: Client, sql: string, row: object) => {
    const actual = client.query.bind(client)
    vi.spyOn(client, 'query').mockImplementation(((input: string, values: unknown[]) => input === sql ? Promise.resolve({ rows: [row] }) : actual(input, values)) as never)
  }
  query(source, SOURCE_HEALTH_SQL, { active: true, wal_status: 'reserved', state: 'streaming', feedback_age: 0, replay_seconds: null, wal_bytes: '0', publication_ok: true })
  query(inventory, DESTINATION_HEALTH_SQL, { subenabled: true, subslotname: REPLICATION.slot, subpublications: [REPLICATION.publication], pid: 42, srsubstate: 'r', receipt_age: 0, observed_at: new Date().toISOString() })
  await peer.connect()
  try {
    await run(inventory, peer, bucket, () => checkCleanupHealth(source, inventory, bucket))
  }
  finally {
    await Promise.all([source.end(), inventory.end()])
    await peer.query('DELETE FROM public.r2_inventory_checkpoints WHERE bucket_name=$1', [bucket])
    await peer.end()
  }
}

describe('cleanup health checkpoint transactions', () => {
  it.concurrent('replaces the old queue-dependent checkpoint with replication-only health', () => fixture(async (_inventory, peer, bucket, check) => {
    await peer.query(`INSERT INTO public.r2_inventory_checkpoints(bucket_name,job_name,checkpoint)
      VALUES ($1,'cleanup_health',jsonb_build_object('schemaVersion',2,'observedAt',clock_timestamp()-interval '1 hour',
        'healthy',false,'notificationsHealthy',false,'deletionBacklog',1000000))`, [bucket])
    const result = await check()
    expect(result).toMatchObject({ schemaVersion: 3, healthy: true })
    const stored = await peer.query(`SELECT checkpoint FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='cleanup_health'`, [bucket])
    expect(stored.rows[0].checkpoint).toEqual(result)
    expect(stored.rows[0].checkpoint).not.toHaveProperty('notificationsHealthy')
    expect(stored.rows[0].checkpoint).not.toHaveProperty('deletionBacklog')
  }))

  it.concurrent('commits the consumer snapshot while the producer uses its returned result', () => fixture(async (_inventory, peer, bucket, check) => {
    const result = await check()
    expect(result.healthy).toBe(true)
    const stored = await peer.query(`SELECT checkpoint FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='cleanup_health'`, [bucket])
    expect(stored.rows[0].checkpoint).toEqual(result)
  }))

  it.concurrent('preserves a newer checkpoint and rejects the stale publication', () => fixture(async (_inventory, peer, bucket, check) => {
    await peer.query(`INSERT INTO public.r2_inventory_checkpoints(bucket_name,job_name,checkpoint) VALUES ($1,'cleanup_health',jsonb_build_object('observedAt',clock_timestamp()+interval '1 hour','healthy',false))`, [bucket])
    expect((await check()).healthy).toBe(false)
    const stored = await peer.query(`SELECT checkpoint FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='cleanup_health'`, [bucket])
    expect(stored.rows[0].checkpoint.healthy).toBe(false)
    expect(stored.rows[0].checkpoint.schemaVersion).toBeUndefined()
  }))

  it.concurrent('cancels a locked publication without allowing a later healthy commit', () => fixture(async (_inventory, peer, bucket, check) => {
    await peer.query(`INSERT INTO public.r2_inventory_checkpoints(bucket_name,job_name,checkpoint) VALUES ($1,'cleanup_health',jsonb_build_object('observedAt',clock_timestamp()-interval '1 hour','healthy',false))`, [bucket])
    await drizzle({ client: peer }).transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM public.r2_inventory_checkpoints WHERE bucket_name=${bucket} FOR UPDATE`)
      const result = await check()
      expect(result.healthy).toBe(false)
    })
    const stored = await peer.query(`SELECT checkpoint FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='cleanup_health'`, [bucket])
    expect(stored.rows[0].checkpoint.healthy).toBe(false)
  }))
})
