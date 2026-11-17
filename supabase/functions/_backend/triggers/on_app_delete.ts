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

/** An app with the same id was created again in the same org: its storage prefix is live again. */
async function appRecreated(pg: PgClient, record: AppRow) {
  const result = await pg.query('SELECT 1 FROM public.apps WHERE app_id = $1 AND owner_org = $2 LIMIT 1', [record.app_id, record.owner_org])
  return result.rows.length > 0
}

async function requeueStorageCleanup(c: Context<MiddlewareKeyVariables>, pg: PgClient, record: AppRow, nextPass: number) {
  const message = {
    function_name: 'on_app_delete',
    payload: {
      type: 'DELETE',
      table: 'apps',
      schema: 'public',
      record: null,
      old_record: record,
      storage_cleanup_pass: nextPass,
    },
  }
  await pg.query('SELECT pgmq.send($1::text, $2::jsonb, $3::integer)', ['on_app_delete', JSON.stringify(message), STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS])
}

/**
 * One cleanup pass. The first pass removes the app's rows; every pass deletes
 * storage under the app prefix until the deadline and, when objects are left,
 * queues the next pass instead of running past the runtime limit.
 */
export async function cleanupDeletedAppResources(
  c: Context<MiddlewareKeyVariables>,
  record: AppRow,
  pass = 0,
) {
  const startTime = Date.now()
  const deadline = startTime + STORAGE_CLEANUP_BUDGET_MS

  const pg = await getPgClient(c)
  try {
    if (pass === 0)
      await deleteAppRows(c, pg, record)

    if (!record.owner_org)
      return

    if (await appRecreated(pg, record)) {
      cloudlog({ requestId: c.get('requestId'), message: 'app recreated, skip storage cleanup', app_id: record.app_id, pass })
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

    if (!done) {
      const nextPass = pass + 1
      if (nextPass >= MAX_STORAGE_CLEANUP_PASSES) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'app storage cleanup gave up after max passes', pass, app_id: record.app_id, owner_org: record.owner_org })
      }
      else {
        try {
          await requeueStorageCleanup(c, pg, record, nextPass)
        }
        catch (error) {
          cloudlogErr({ requestId: c.get('requestId'), message: 'error requeuing app storage cleanup', error, pass, app_id: record.app_id })
        }
      }
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

  await backgroundTask(c, cleanupDeletedAppResources(c, record, pass))

  return c.json(BRES)
})
