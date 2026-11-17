import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, triggerValidator } from '../utils/hono.ts'
import { removeImageFolder } from '../utils/image_storage.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { s3 } from '../utils/s3.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

type AppRow = Database['public']['Tables']['apps']['Row']

// Storage work per pass. Cleanup runs in waitUntil, which Cloudflare stops 30s
// after the response, so each pass stops starting new delete batches after this
// and hands the rest of the prefix to a delayed follow-up message.
export const STORAGE_CLEANUP_BUDGET_MS = 20_000
// Follow-up passes are new queue messages (each with its own read count), not
// retries. Each pass removes thousands of objects, so this bounds even huge apps
// while making sure a prefix that never empties cannot requeue forever.
export const MAX_STORAGE_CLEANUP_PASSES = 50
export const STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS = 5
// After this, public.requeue_stalled_app_storage_cleanups assumes a pass died
// (worker stopped, next message not queued) and queues the next one.
export const STORAGE_CLEANUP_LEASE_SECONDS = 120

function readCleanupPass(body: unknown): number {
  const pass = (body as { storage_cleanup_pass?: unknown } | null)?.storage_cleanup_pass
  return typeof pass === 'number' && Number.isInteger(pass) && pass > 0 ? pass : 0
}

async function deleteAppRows(c: Context<MiddlewareKeyVariables>, pg: PgClient, record: AppRow) {
  // Errors were ignored under supabase-js; log them and keep going.
  const deleteByAppId = (table: string) => pg.query(`DELETE FROM public.${table} WHERE app_id = $1`, [record.app_id])
    .catch((error: unknown) => cloudlog({ requestId: c.get('requestId'), message: `error deleting ${table}`, error, app_id: record.app_id }))

  // Run most deletions in parallel
  await Promise.all([
    'app_versions_meta',
    'daily_version',
    'version_usage',
    'channel_devices',
    'channels',
    'devices',
    'org_users',
    'deploy_history',
  ].map(deleteByAppId))

  await deleteByAppId('app_versions')
}

/**
 * Claims storage pass `pass` in public.app_storage_cleanups before the queue message is
 * acknowledged, so a pass that dies is requeued by the sweeper. The database decides, under the
 * lock the apps INSERT trigger takes, whether the app id exists again in this org: false means
 * its prefix is live again and nothing may be deleted.
 */
async function beginStoragePass(c: Context<MiddlewareKeyVariables>, record: AppRow, pass: number): Promise<boolean> {
  const pg = await getPgClient(c)
  try {
    const result = await pg.query<{ claimed: boolean }>(
      'SELECT public.begin_app_storage_cleanup_pass($1::text, $2::uuid, $3::integer, $4::integer) AS claimed',
      [record.app_id, record.owner_org, pass, STORAGE_CLEANUP_LEASE_SECONDS],
    )
    return result.rows[0]?.claimed === true
  }
  finally {
    closeClient(c, pg)
  }
}

/**
 * Ends storage pass `pass`: clears the cleanup state when `done`, otherwise queues the next
 * pass with a delay unless the app id exists again in this org. Returns whether a pass was queued.
 */
async function finishStoragePass(pg: PgClient, record: AppRow, pass: number, done: boolean): Promise<boolean> {
  const result = await pg.query<{ msg_id: string | number | null }>(
    'SELECT public.finish_app_storage_cleanup_pass($1::text, $2::uuid, $3::integer, $4::boolean, $5::integer, $6::integer) AS msg_id',
    [record.app_id, record.owner_org, pass, done, STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS, STORAGE_CLEANUP_LEASE_SECONDS],
  )
  return result.rows[0]?.msg_id != null
}

/**
 * One cleanup pass. The first pass removes the app's rows; every claimed pass deletes storage
 * under the app prefix until the deadline and then finishes the pass, which queues the next one
 * when objects are left instead of running past the runtime limit.
 */
export async function cleanupDeletedAppResources(
  c: Context<MiddlewareKeyVariables>,
  record: AppRow,
  pass = 0,
  storageClaimed = true,
) {
  const startTime = Date.now()
  const deadline = startTime + STORAGE_CLEANUP_BUDGET_MS

  const pg = await getPgClient(c)
  try {
    if (pass === 0)
      await deleteAppRows(c, pg, record)

    if (!record.owner_org)
      return
    if (!storageClaimed) {
      cloudlog({ requestId: c.get('requestId'), message: 'app recreated, skip storage cleanup', pass, app_id: record.app_id })
      return
    }

    // Delete app icon from image storage
    // App icons are stored at: images/org/{org_id}/{app_id}/icon
    try {
      const deleted = await removeImageFolder(c, `org/${record.owner_org}/${record.app_id}`, { deadline })
      if (deleted > 0)
        cloudlog({ requestId: c.get('requestId'), message: 'deleted app images', count: deleted, app_id: record.app_id })
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error deleting app images', error, app_id: record.app_id })
    }

    let done = true
    try {
      const result = await s3.deleteObjectsWithPrefix(c, `orgs/${record.owner_org}/apps/${record.app_id}/`, { deadline })
      done = result.done
      cloudlog({ requestId: c.get('requestId'), message: 'deleted app storage objects', count: result.deleted, failed: result.failed, done, pass, app_id: record.app_id })
    }
    catch (error) {
      done = false
      cloudlog({ requestId: c.get('requestId'), message: 'error deleting app storage objects', error, pass, app_id: record.app_id })
    }

    const outOfPasses = !done && pass + 1 >= MAX_STORAGE_CLEANUP_PASSES
    if (outOfPasses)
      cloudlogErr({ requestId: c.get('requestId'), message: 'app storage cleanup gave up after max passes', pass, app_id: record.app_id, owner_org: record.owner_org })
    try {
      const queued = await finishStoragePass(pg, record, pass, done || outOfPasses)
      if (!done && !outOfPasses && !queued)
        cloudlog({ requestId: c.get('requestId'), message: 'app recreated, stop storage cleanup', pass, app_id: record.app_id })
    }
    catch (error) {
      // The claimed state stays; requeue_stalled_app_storage_cleanups queues the next pass.
      cloudlogErr({ requestId: c.get('requestId'), message: 'error finishing app storage cleanup pass', error, pass, app_id: record.app_id })
    }
  }
  finally {
    closeClient(c, pg)
  }

  cloudlog({
    requestId: c.get('requestId'),
    context: 'app deletion completed',
    duration_ms: Date.now() - startTime,
    app_id: record.app_id,
    pass,
  })
}

app.post('/', middlewareAPISecret, triggerValidator('apps', 'DELETE'), async (c) => {
  const record = c.get('webhookBody') as AppRow
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record?.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'no app id' })
    return c.json(BRES)
  }

  const pass = readCleanupPass(await parseBody<unknown>(c).catch(() => null))

  // Persist the pass before this message is acknowledged: a database error here fails the
  // request, so the queue retries it; once claimed, a pass that dies is requeued by the sweeper.
  const storageClaimed = record.owner_org ? await beginStoragePass(c, record, pass) : false

  // Track deleted app for billing before returning (queue consumer 15s HTTP budget).
  // Follow-up storage passes were already recorded by the first one.
  if (pass === 0) {
    let pg: PgClient | undefined
    try {
      pg = await getPgClient(c)
      await pg.query(
        `INSERT INTO public.deleted_apps (app_id, created_at, owner_org, transfer_history)
        VALUES ($1, $2, $3, ARRAY(SELECT pg_catalog.jsonb_array_elements($4::jsonb)))`,
        [record.app_id, record.created_at, record.owner_org, JSON.stringify(record.transfer_history ?? [])],
      )
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error inserting deleted_apps', error, app_id: record.app_id })
    }
    finally {
      if (pg)
        closeClient(c, pg)
    }
  }

  await backgroundTask(c, cleanupDeletedAppResources(c, record, pass, storageClaimed))

  return c.json(BRES)
})
