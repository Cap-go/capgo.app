import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { s3 } from '../utils/s3.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('apps', 'DELETE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['apps']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record?.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'no app id' })
    return c.json(BRES)
  }

  // Process app deletion with timeout protection
  const startTime = Date.now()

  // Track deleted app for billing
  await supabaseAdmin(c)
    .from('deleted_apps')
    .insert({
      app_id: record.app_id,
      created_at: record.created_at,
      owner_org: record.owner_org,
      transfer_history: record.transfer_history ?? [],
    })

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
      const trashedObjectCount = await s3.moveObjectsWithPrefixToTrash(c, `orgs/${record.owner_org}/apps/${record.app_id}/`)
      cloudlog({ requestId: c.get('requestId'), message: 'moved app storage objects to trash', count: trashedObjectCount, app_id: record.app_id })
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error moving app storage objects to trash', error, app_id: record.app_id })
    }
  }

  // Run most deletions in parallel
  await Promise.all([
    // Delete version related data
    supabaseAdmin(c)
      .from('app_versions_meta')
      .delete()
      .eq('app_id', record.app_id),

    // Delete daily version stats
    supabaseAdmin(c)
      .from('daily_version')
      .delete()
      .eq('app_id', record.app_id),

    // Delete version usage
    supabaseAdmin(c)
      .from('version_usage')
      .delete()
      .eq('app_id', record.app_id),

    // Delete app related data
    // Delete channel devices
    supabaseAdmin(c)
      .from('channel_devices')
      .delete()
      .eq('app_id', record.app_id),

    // Delete channels
    supabaseAdmin(c)
      .from('channels')
      .delete()
      .eq('app_id', record.app_id),

    // Delete devices
    supabaseAdmin(c)
      .from('devices')
      .delete()
      .eq('app_id', record.app_id),

    // Delete org_users with this app_id
    supabaseAdmin(c)
      .from('org_users')
      .delete()
      .eq('app_id', record.app_id),

    supabaseAdmin(c)
      .from('deploy_history')
      .delete()
      .eq('app_id', record.app_id),
  ])

  // Delete versions (last)
  await supabaseAdmin(c)
    .from('app_versions')
    .delete()
    .eq('app_id', record.app_id)

  // Track performance metrics
  const endTime = Date.now()
  const duration = endTime - startTime

  cloudlog({
    requestId: c.get('requestId'),
    context: 'app deletion completed',
    duration_ms: duration,
    app_id: record.app_id,
  })

  return c.json(BRES)
})
