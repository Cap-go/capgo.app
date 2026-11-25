#!/usr/bin/env bun
// Local stand-in for prod's queue wakeup path: the database writes wakeups to
// public.http_dispatch_outbox and the QueueDispatcher Durable Object in the
// local API worker sends them, instead of pg_net.
//
// Every tick this (re)applies the routing, because `supabase db reset` re-seeds
// db_url and empties http_dispatch_targets, then fires the API worker's minute
// cron, which (re)starts the dispatcher's own 1 s alarm. On exit it puts the
// seed values back, so a Supabase-only run (no workers) uses pg_net again.
//
// Started by scripts/start-cloudflare-workers.sh when LOCAL_QUEUE_DISPATCHER=true.
import process from 'node:process'
import { Client } from 'pg'
import { z } from 'zod'

export const LOCAL_API_WORKER = 'capgo_api-local'
// seed.sql value: reachable from pg_net inside the Docker network, not from the host.
export const SEED_DB_URL = 'http://kong:8000'
const CRON = '* * * * *'
const TICK_MS = 60_000
const RETRY_MS = 2_000

const envSchema = z.object({
  SUPABASE_DB_URL: z.string().min(1),
  SUPABASE_URL: z.url(),
  CLOUDFLARE_API_PORT: z.coerce.number().int().min(1).max(65535),
})

/** The outbox URLs are built from db_url, so it must be the host URL the worker can reach. */
export function hostDbUrl(supabaseUrl: string): string {
  return new URL(supabaseUrl).origin
}

export function scheduledTriggerUrl(apiPort: number): string {
  // wrangler dev's /__scheduled would hit the local router worker (the primary
  // config), not the API worker; the local explorer API targets a worker by name.
  return `http://127.0.0.1:${apiPort}/cdn-cgi/local/explorer/api/local/scheduled?worker=${LOCAL_API_WORKER}`
}

async function withDb<T>(dbUrl: string, run: (client: Client) => Promise<T>): Promise<T> {
  // A fresh connection per tick survives a Supabase restart.
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 5_000, query_timeout: 10_000 })
  // A dropped connection also rejects the pending query, which the loop handles;
  // without a listener the separate 'error' event would crash the process.
  client.on('error', () => {})
  await client.connect()
  try {
    return await run(client)
  }
  finally {
    await client.end()
  }
}

// One statement each, so db_url and the route always switch together: a wakeup
// in between would send the host URL through pg_net (inside Docker), or the
// Docker URL through the outbox.
export async function routeToOutbox(client: Pick<Client, 'query'>, dbUrl: string): Promise<void> {
  await client.query(
    `WITH route AS (
       INSERT INTO public.http_dispatch_targets (target) VALUES ('*') ON CONFLICT DO NOTHING
     )
     INSERT INTO private.settings (name, value) VALUES ('db_url', $1)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = pg_catalog.now()
     WHERE private.settings.value IS DISTINCT FROM EXCLUDED.value`,
    [dbUrl],
  )
}

export async function restorePgNet(client: Pick<Client, 'query'>, dbUrl: string): Promise<void> {
  // Only undo our own db_url value; anything else was set on purpose.
  await client.query(
    `WITH unroute AS (
       DELETE FROM public.http_dispatch_targets WHERE target = '*'
     )
     UPDATE private.settings SET value = $1, updated_at = pg_catalog.now() WHERE name = 'db_url' AND value = $2`,
    [SEED_DB_URL, dbUrl],
  )
}

async function fireCron(apiPort: number): Promise<void> {
  const response = await fetch(scheduledTriggerUrl(apiPort), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cron: CRON }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.text()
  if (!response.ok)
    throw new Error(`scheduled trigger HTTP ${response.status}: ${body.slice(0, 200)}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const env = envSchema.parse(process.env)
  const dbUrl = hostDbUrl(env.SUPABASE_URL)
  let stopping = false
  let started = false
  let failedStarts = 0
  let wake: (() => void) | undefined

  const stop = () => {
    stopping = true
    wake?.()
  }
  // `on`, not `once`: a second signal must not kill the restore below.
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  while (!stopping) {
    try {
      await withDb(env.SUPABASE_DB_URL, client => routeToOutbox(client, dbUrl))
      await fireCron(env.CLOUDFLARE_API_PORT)
      if (!started)
        console.log(`Local queue dispatcher: wakeups go to the outbox (db_url=${dbUrl}), QueueDispatcher started`)
      started = true
    }
    catch (error) {
      // Before the first success the workers are usually still starting, so
      // only report a start that keeps failing (about once a minute).
      if (started || ++failedStarts % 30 === 0)
        console.error(`Local queue dispatcher tick failed: ${errorMessage(error)}`)
    }
    if (stopping)
      break
    await new Promise<void>((resolveWait) => {
      // Cleared on wake: a pending timer would keep the process alive after the restore.
      const timer = setTimeout(resolveWait, started ? TICK_MS : RETRY_MS)
      wake = () => {
        clearTimeout(timer)
        resolveWait()
      }
    })
  }

  try {
    await withDb(env.SUPABASE_DB_URL, client => restorePgNet(client, dbUrl))
    console.log('Local queue dispatcher stopped: wakeups go back to pg_net')
  }
  catch (error) {
    console.error(`Local queue dispatcher could not restore pg_net routing: ${errorMessage(error)}`)
  }
}

if (import.meta.main)
  await main()
