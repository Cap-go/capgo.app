import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, triggerValidator } from '../utils/hono.ts'
import { removeImageFolder } from '../utils/image_storage.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { s3 } from '../utils/s3.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

async function cleanupDeletedAppResources(
  c: Context<MiddlewareKeyVariables>,
  record: Database['public']['Tables']['apps']['Row'],
) {
  const startTime = Date.now()

  // Delete app icon from image storage
  // App icons are stored at: images/org/{org_id}/{app_id}/icon
  if (record.owner_org) {
    try {
      const deleted = await removeImageFolder(c, `org/${record.owner_org}/${record.app_id}`)
      if (deleted > 0)
        cloudlog({ requestId: c.get('requestId'), message: 'deleted app images', count: deleted, app_id: record.app_id })
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error deleting app images', error, app_id: record.app_id })
    }

    try {
      const deletedObjectCount = await s3.deleteObjectsWithPrefix(c, `orgs/${record.owner_org}/apps/${record.app_id}/`)
      cloudlog({ requestId: c.get('requestId'), message: 'deleted app storage objects', count: deletedObjectCount, app_id: record.app_id })
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error deleting app storage objects', error, app_id: record.app_id })
    }
  }

  const pg = await getPgClient(c)
  try {
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
  finally {
    closeClient(c, pg)
  }

  cloudlog({
    requestId: c.get('requestId'),
    context: 'app deletion completed',
    duration_ms: Date.now() - startTime,
    app_id: record.app_id,
  })
}

app.post('/', middlewareAPISecret, triggerValidator('apps', 'DELETE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['apps']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record?.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'no app id' })
    return c.json(BRES)
  }

  // Track deleted app for billing before returning (queue consumer 15s HTTP budget).
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

  await backgroundTask(c, cleanupDeletedAppResources(c, record))

  return c.json(BRES)
})
