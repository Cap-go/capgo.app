import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { s3 } from '../utils/s3.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

async function cleanupDeletedAppResources(
  c: Context<MiddlewareKeyVariables>,
  record: Database['public']['Tables']['apps']['Row'],
) {
  const startTime = Date.now()

  // Delete app icon from storage
  // App icons are stored at: images/org/{org_id}/{app_id}/icon
  if (record.owner_org) {
    try {
      const { data: files } = await supabaseAdmin(c)
        .storage
        .from('images')
        .list(`org/${record.owner_org}/${record.app_id}`)

      if (files && files.length > 0) {
        const filePaths = files.map(file => `org/${record.owner_org}/${record.app_id}/${file.name}`)
        await supabaseAdmin(c)
          .storage
          .from('images')
          .remove(filePaths)
        cloudlog({ requestId: c.get('requestId'), message: 'deleted app images', count: files.length, app_id: record.app_id })
      }
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

  // Run most deletions in parallel
  await Promise.all([
    supabaseAdmin(c)
      .from('app_versions_meta')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('daily_version')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('version_usage')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('channel_devices')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('channels')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('devices')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('org_users')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('deploy_history')
      .delete()
      .eq('app_id', record.app_id),
  ])

  await supabaseAdmin(c)
    .from('app_versions')
    .delete()
    .eq('app_id', record.app_id)

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
  await supabaseAdmin(c)
    .from('deleted_apps')
    .insert({
      app_id: record.app_id,
      created_at: record.created_at,
      owner_org: record.owner_org,
      transfer_history: record.transfer_history ?? [],
    })

  await backgroundTask(c, cleanupDeletedAppResources(c, record))

  return c.json(BRES)
})
