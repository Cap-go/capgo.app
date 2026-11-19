import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { ORG_ID, POSTGRES_URL } from './test-utils.ts'

const DEMO_APP = 'com.demo.app'

const REPLACE_HOURLY_SQL = `SELECT public.replace_app_storage_hourly(
  $1::varchar,
  $2::uuid,
  CURRENT_DATE,
  CURRENT_DATE + 1,
  CURRENT_DATE + 2,
  '-infinity'::timestamptz,
  '[]'::jsonb,
  pg_catalog.clock_timestamp(),
  true)`

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

async function waitForRelationLockWait(observer: Client, pid: number, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const blocked = await observer.query(
      `SELECT 1
       FROM pg_catalog.pg_locks waiting
       INNER JOIN pg_catalog.pg_stat_activity blocked
         ON blocked.pid = waiting.pid
       WHERE waiting.pid = $1
         AND waiting.locktype = 'relation'
         AND waiting.granted = false
         AND blocked.wait_event_type = 'Lock'
       LIMIT 1`,
      [pid],
    )
    if (blocked.rowCount === 1)
      return
  }
  throw new Error(`pid ${pid} did not enter a relation lock wait within ${deadlineMs}ms`)
}

describe('storage gb-hours migration lock order vs replace_app_storage_hourly', () => {
  const clients: Client[] = []

  afterAll(async () => {
    await Promise.all(clients.map(c => c.end().catch(() => undefined)))
  })

  function connect() {
    const client = new Client({
      connectionString: POSTGRES_URL,
      connectionTimeoutMillis: 5_000,
    })
    clients.push(client)
    return client
  }

  it('apps-first migration locks let DSH exclusive commit while the writer waits on apps', async () => {
    const migrator = connect()
    const writer = connect()
    await migrator.connect()
    await writer.connect()
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

    try {
      await migrator.query('BEGIN')
      await migrator.query(`SET LOCAL lock_timeout = '2s'`)
      await migrator.query('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE')

      const writerWork = (async () => {
        await writer.query('BEGIN')
        await writer.query(`SET LOCAL lock_timeout = '2s'`)
        return writer.query(REPLACE_HOURLY_SQL, [DEMO_APP, ORG_ID])
      })()

      await waitForRelationLockWait(migrator, writerPid)

      await migrator.query(`SET LOCAL lock_timeout = '2s'`)
      await migrator.query('LOCK TABLE public.daily_storage_hourly IN ACCESS EXCLUSIVE MODE')
      await migrator.query('COMMIT')

      await withTimeout(writerWork, 10_000, 'writer after migrator commit')
      await writer.query('ROLLBACK')
    }
    finally {
      await migrator.query('ROLLBACK').catch(() => undefined)
      await writer.query('ROLLBACK').catch(() => undefined)
    }
  })

  it('dsh-first lock order cannot take apps exclusive while the writer holds share', async () => {
    const migrator = connect()
    const writer = connect()
    await migrator.connect()
    await writer.connect()
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

    try {
      await migrator.query('BEGIN')
      await migrator.query(`SET LOCAL lock_timeout = '2s'`)
      await migrator.query('LOCK TABLE public.daily_storage_hourly IN ACCESS EXCLUSIVE MODE')

      const writerWork = writer.query('BEGIN').then(() =>
        writer.query(REPLACE_HOURLY_SQL, [DEMO_APP, ORG_ID]),
      ).catch(() => undefined)

      await waitForRelationLockWait(migrator, writerPid)

      await migrator.query(`SET LOCAL lock_timeout = '500ms'`)
      await expect(migrator.query('LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE'))
        .rejects.toMatchObject({ code: '55P03' })

      await migrator.query('ROLLBACK')
      await writerWork
    }
    finally {
      await migrator.query('ROLLBACK').catch(() => undefined)
      await writer.query('ROLLBACK').catch(() => undefined)
    }
  })
})