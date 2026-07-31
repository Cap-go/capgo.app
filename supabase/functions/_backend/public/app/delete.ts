import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { BRES, simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { s3 } from '../../utils/s3.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

export async function deleteApp(c: Context<MiddlewareKeyVariables>, appId: string, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!appId) {
    throw simpleError('missing_app_id', 'Missing app_id')
  }
  if (!isValidAppId(appId)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.delete', { appId }))) {
    throw simpleError('cannot_delete_app', 'You can\'t access this app', { app_id: appId })
  }

  // Use authenticated client for data queries - RLS will enforce access
  const supabase = supabaseApikey(c, apikey.key)

  // Get the app's owner_org for image cleanup
  const { data: app } = await supabase
    .from('apps')
    .select('owner_org')
    .eq('app_id', appId)
    .single()
  const appStoragePrefix = app?.owner_org ? `orgs/${app.owner_org}/apps/${appId}/` : null

  // Delete app icon from storage before deleting the app
  // App icons are stored at: images/org/{org_id}/{app_id}/icon
  // Note: Storage operations need admin access
  if (app?.owner_org) {
    try {
      const { data: files } = await supabaseAdmin(c)
        .storage
        .from('images')
        .list(`org/${app.owner_org}/${appId}`)

      if (files && files.length > 0) {
        const filePaths = files.map(file => `org/${app.owner_org}/${appId}/${file.name}`)
        await supabaseAdmin(c)
          .storage
          .from('images')
          .remove(filePaths)
        cloudlog({ requestId: c.get('requestId'), message: 'deleted app images', count: files.length, app_id: appId })
      }
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error deleting app images', error, app_id: appId })
    }
  }

  // Admin client for internal stats tables that have restrictive RLS policies
  const admin = supabaseAdmin(c)

  // Run most deletions in parallel
  await Promise.all([
    // Delete version related data (user-facing, has RLS)
    supabase
      .from('app_versions_meta')
      .delete()
      .eq('app_id', appId),

    // Delete daily version stats (internal, needs admin - only has SELECT RLS)
    admin
      .from('daily_version')
      .delete()
      .eq('app_id', appId),

    // Delete version usage (internal, needs admin)
    admin
      .from('version_usage')
      .delete()
      .eq('app_id', appId),

    // Delete app related data
    // Delete channel devices (user-facing, has RLS)
    supabase
      .from('channel_devices')
      .delete()
      .eq('app_id', appId),

    // Delete channels (user-facing, has RLS)
    supabase
      .from('channels')
      .delete()
      .eq('app_id', appId),

    // Delete devices (user-facing, has RLS)
    supabase
      .from('devices')
      .delete()
      .eq('app_id', appId),

    // Delete usage stats (internal, needs admin - has "Disable for all" policy)
    admin
      .from('bandwidth_usage')
      .delete()
      .eq('app_id', appId),

    admin
      .from('storage_usage')
      .delete()
      .eq('app_id', appId),

    admin
      .from('device_usage')
      .delete()
      .eq('app_id', appId),

    // Delete daily metrics (internal, needs admin)
    admin
      .from('daily_mau')
      .delete()
      .eq('app_id', appId),

    admin
      .from('daily_bandwidth')
      .delete()
      .eq('app_id', appId),

    admin
      .from('daily_storage')
      .delete()
      .eq('app_id', appId),

    // Delete stats (internal, needs admin)
    admin
      .from('stats')
      .delete()
      .eq('app_id', appId),

    // App deletion is already authorized above; app-scoped membership cleanup is internal.
    admin
      .from('org_users')
      .delete()
      .eq('app_id', appId),

    // Delete deploy_history (has "Deny delete" policy, needs admin)
    admin
      .from('deploy_history')
      .delete()
      .eq('app_id', appId),
  ])

  // Delete versions (last) - needs admin because no DELETE policy for anon role
  await admin
    .from('app_versions')
    .delete()
    .eq('app_id', appId)

  // Finally delete the app - needs admin because no DELETE policy for anon role
  const { error: dbError } = await admin
    .from('apps')
    .delete()
    .eq('app_id', appId)

  if (dbError) {
    throw simpleError('cannot_delete_app', 'Cannot delete app', { supabaseError: dbError })
  }

  if (appStoragePrefix) {
    try {
      const deletedObjectCount = await s3.deleteObjectsWithPrefix(c, appStoragePrefix)
      cloudlog({ requestId: c.get('requestId'), message: 'deleted app storage objects', count: deletedObjectCount, app_id: appId })
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'error deleting app storage objects', error, app_id: appId })
    }
  }

  return c.json(BRES)
}
