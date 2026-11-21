import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relayedQueueClaimSql } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import { pgmqRelayReadSql, pgmqRelayReleaseSql } from '../supabase/functions/_backend/triggers/queue_relay.ts'
import { executeSQL } from './test-utils.ts'

// The relay SQL against real pgmq tables: the relay read hides messages
// without counting a read, the release after a failed send makes them
// readable again, and the consumer claim counts the read and takes each
// relayed copy at most once.
const queueName = `test_relay_${randomUUID().replaceAll('-', '').slice(0, 12)}`

interface QueueRow {
  msg_id: string
  read_ct: number
  readable: boolean
}

async function queueRows(): Promise<QueueRow[]> {
  return executeSQL<QueueRow>(`SELECT msg_id::text, read_ct, vt <= pg_catalog.clock_timestamp() AS readable FROM pgmq."q_${queueName}" ORDER BY msg_id`)
}

async function relayRead() {
  const rows = await executeSQL<{ msg_id: string, read_ct: number }>(pgmqRelayReadSql(queueName), [300, 10])
  return rows.map(row => [Number(row.msg_id), row.read_ct]).sort((a, b) => a[0] - b[0])
}

async function claim(msgIds: number[], readCounts: number[]) {
  const rows = await executeSQL<{ msg_id: string, read_ct: number, message: { payload: { n: number } } }>(
    relayedQueueClaimSql(queueName),
    [msgIds, readCounts, 120],
  )
  return rows.map(row => [Number(row.msg_id), row.read_ct, row.message.payload.n])
}

describe('pgmq relay SQL', () => {
  let ids: number[] = []

  beforeAll(async () => {
    await executeSQL('SELECT pgmq.create($1)', [queueName])
    const sent = await executeSQL<{ id: string }>(
      'SELECT pgmq.send_batch($1, ARRAY[$2::jsonb, $3::jsonb, $4::jsonb]) AS id',
      [queueName, ...[1, 2, 3].map(n => JSON.stringify({ function_name: 'noop', payload: { n } }))],
    )
    ids = sent.map(row => Number(row.id))
  })

  afterAll(async () => {
    await executeSQL('SELECT pgmq.drop_queue($1)', [queueName])
  })

  it('hides the readable messages without counting a read', async () => {
    expect(await relayRead()).toEqual(ids.map(id => [id, 0]))
    expect(await queueRows()).toEqual(ids.map(id => ({ msg_id: String(id), read_ct: 0, readable: false })))
    expect(await relayRead()).toEqual([])
  })

  it('releases only unsent messages still at the relayed read count', async () => {
    await executeSQL(pgmqRelayReleaseSql(queueName), [[ids[2]], [1]])
    expect((await queueRows())[2]).toMatchObject({ read_ct: 0, readable: false })

    await executeSQL(pgmqRelayReleaseSql(queueName), [[ids[2]], [0]])
    expect((await queueRows())[2]).toMatchObject({ read_ct: 0, readable: true })
  })

  it('claims each relayed copy once, counting the read and restarting the visibility timeout', async () => {
    // Message 2 is claimed with a stale read count, as if another copy had been claimed.
    expect(await claim([ids[0], ids[1]], [0, 1])).toEqual([[ids[0], 1, 1]])
    // A Cloudflare Queues retry of the same copy finds nothing left to claim.
    expect(await claim([ids[0]], [0])).toEqual([])

    const [vt] = await executeSQL<{ seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM vt - pg_catalog.clock_timestamp())::float8 AS seconds FROM pgmq."q_${queueName}" WHERE msg_id = $1`,
      [ids[0]],
    )
    expect(vt.seconds).toBeGreaterThan(100)
    expect(vt.seconds).toBeLessThanOrEqual(120)
    expect((await queueRows()).map(row => row.read_ct)).toEqual([1, 0, 0])
  })

  it('relays a released message again', async () => {
    expect(await relayRead()).toEqual([[ids[2], 0]])
  })
})
