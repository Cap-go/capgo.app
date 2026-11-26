#!/usr/bin/env bun
// Local and CI side of the queue wakeup path: the database writes wakeups to
// public.http_dispatch_outbox and the QueueDispatcher Durable Object in the
// local API worker sends them, like prod. Nothing else drains the outbox.
//
// Every tick this points db_url at the host Supabase URL (the outbox URLs are
// built from it, and `supabase db reset` re-seeds the Docker-only kong URL),
// then fires the API worker's minute cron, which (re)starts the dispatcher's
// own 1 s alarm.
//
// Started by scripts/start-cloudflare-workers.sh unless LOCAL_QUEUE_DISPATCHER=false.
import process from 'node:process'
import { Client } from 'pg'
import { z } from 'zod'

export const LOCAL_API_WORKER = 'capgo_api-local'
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

export async function pointDbUrlAtHost(client: Pick<Client, 'query'>, dbUrl: string): Promise<void> {
  await client.query(
    `INSERT INTO private.settings (name, value) VALUES ('db_url', $1)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = pg_catalog.now()
     WHERE private.settings.value IS DISTINCT FROM EXCLUDED.value`,
    [dbUrl],
  )
}

async function setDbUrl(connectionString: string, dbUrl: string): Promise<void> {
  // A fresh connection per tick survives a Supabase restart.
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 10_000 })
  // A dropped connection also rejects the pending query, which the loop handles;
  // without a listener the separate 'error' event would crash the process.
  client.on('error', () => {})
  await client.connect()
  try {
    await pointDbUrlAtHost(client, dbUrl)
  }
  finally {
    await client.end()
  }
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
  let started = false
  let failedStarts = 0

  // Runs until start-cloudflare-workers.sh stops it; there is nothing to undo.
  while (true) {
    try {
      await setDbUrl(env.SUPABASE_DB_URL, dbUrl)
      await fireCron(env.CLOUDFLARE_API_PORT)
      if (!started)
        console.log(`Local queue dispatcher started (db_url=${dbUrl})`)
      started = true
    }
    catch (error) {
      // Before the first success the workers are usually still starting, so
      // only report a start that keeps failing (about once a minute).
      if (started || ++failedStarts % 30 === 0)
        console.error(`Local queue dispatcher tick failed: ${errorMessage(error)}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, started ? TICK_MS : RETRY_MS))
  }
}

if (import.meta.main)
  await main()
