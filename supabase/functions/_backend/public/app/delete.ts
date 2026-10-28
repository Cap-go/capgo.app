import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { PgClient, PgQueryClient } from '../../utils/pg.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { BRES, simpleError } from '../../utils/hono.ts'
import { removeImageFolder } from '../../utils/image_storage.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { apikeyPrincipal, queryJsonOne, withRlsTransaction } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { s3 } from '../../utils/s3.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

const STORAGE_LIST_PAGE_SIZE = 100
const STORAGE_REMOVE_BATCH_SIZE = 1000
const STORAGE_MAX_FOLDER_DEPTH = 5

// Supabase Storage reports failures through `{ error }` instead of throwing, and
// `list()` is paginated (100 entries by default) and not recursive.
async function listSupabaseStorageFiles(
  c: Context<MiddlewareKeyVariables>,
  bucket: string,
  prefix: string,
  depth = 0,
): Promise<string[]> {
  const paths: string[] = []
  for (let offset = 0; ; offset += STORAGE_LIST_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin(c)
      .storage
      .from(bucket)
      .list(prefix, { limit: STORAGE_LIST_PAGE_SIZE, offset })
    if (error)
      throw error
    const entries = data ?? []
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`
      // Folders are returned as placeholder entries without an id.
      if (entry.id === null) {
        if (depth < STORAGE_MAX_FOLDER_DEPTH)
          paths.push(...await listSupabaseStorageFiles(c, bucket, path, depth + 1))
      }
      else {
        paths.push(path)
      }
    }
    if (entries.length < STORAGE_LIST_PAGE_SIZE)
      return paths
  }
}

async function removeSupabaseStorageFolder(
  c: Context<MiddlewareKeyVariables>,
  bucket: string,
  prefix: string,
  appId: string,
  label: string,
): Promise<void> {
  try {
    const paths = await listSupabaseStorageFiles(c, bucket, prefix)
    for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
      const { error } = await supabaseAdmin(c)
        .storage
        .from(bucket)
        .remove(paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE))
      if (error)
        throw error
    }
    if (paths.length > 0)
      cloudlog({ requestId: c.get('requestId'), message: `deleted ${label}`, count: paths.length, app_id: appId })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: `error deleting ${label}`, error, app_id: appId })
  }
}

// Version-related and app-related user-facing tables (have RLS)
const APIKEY_DELETE_TABLES = ['app_versions_meta', 'channel_devices', 'channels', 'devices'] as const

// Internal tables that need the service connection. Keep daily_mau / daily_bandwidth /
// daily_build_time: they stay billable through deleted_apps for the rest of the cycle
// (anti-fraud, so deleting and recreating an app cannot reset usage).
// delete_old_deleted_apps purges them after 35 days, same as the dashboard deletion path.
// An app_id recreated in that window, even by another org, shares these rows on purpose;
// see docs/billing-usage-retention.md. App deletion is already authorized, so app-scoped
// org_users cleanup is internal; deploy_history has a "Deny delete" policy.
const ADMIN_DELETE_TABLES = ['daily_version', 'version_usage', 'bandwidth_usage', 'storage_usage', 'device_usage', 'daily_storage', 'stats', 'org_users', 'deploy_history'] as const

// Each delete used to be its own PostgREST request whose error was ignored; a savepoint
// keeps that isolation for statements sharing the API-key transaction.
async function deleteAppRows(c: Context<MiddlewareKeyVariables>, client: PgClient | PgQueryClient, table: string, appId: string, inTransaction: boolean) {
  try {
    if (inTransaction)
      await client.query('SAVEPOINT delete_app_rows')
    await client.query(`DELETE FROM public.${table} WHERE app_id = $1`, [appId])
    if (inTransaction)
      await client.query('RELEASE SAVEPOINT delete_app_rows')
  }
  catch (error) {
    if (inTransaction)
      await client.query('ROLLBACK TO SAVEPOINT delete_app_rows')
    cloudlogErr({ requestId: c.get('requestId'), message: `error deleting ${table}`, error, app_id: appId })
  }
}

async function deleteAppData(c: Context<MiddlewareKeyVariables>, appId: string, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<string | null> {
  const pg = await getPgClient(c)
  try {
    // Use the API key's RLS context for data queries - RLS will enforce access
    const apikeyRls = apikeyPrincipal(c, apikey.key)

    // Get the app's owner_org for image cleanup
    const app = await withRlsTransaction(pg, apikeyRls, client => queryJsonOne<{ owner_org: string }>(
      client,
      'SELECT owner_org FROM public.apps WHERE app_id = $1',
      [appId],
    )).catch(() => null)
    const appStoragePrefix = app?.owner_org ? `orgs/${app.owner_org}/apps/${appId}/` : null

    // Legacy per-user Supabase storage folder used by older CLI uploads.
    // The `apps` bucket stores objects under {user_id}/{app_id}/...
    if (apikey.user_id)
      await removeSupabaseStorageFolder(c, 'apps', `${apikey.user_id}/${appId}`, appId, 'legacy user-scoped app storage')

    // Delete app icon from image storage (R2) before deleting the app
    // App icons are stored at: images/org/{org_id}/{app_id}/icon
    if (app?.owner_org) {
      try {
        const deleted = await removeImageFolder(c, `org/${app.owner_org}/${appId}`)
        if (deleted > 0)
          cloudlog({ requestId: c.get('requestId'), message: 'deleted app images', count: deleted, app_id: appId })
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'error deleting app images', error, app_id: appId })
      }
    }

    // User-facing tables (have RLS): deleted under the API key, each failure ignored like before
    await withRlsTransaction(pg, apikeyRls, async (client) => {
      for (const table of APIKEY_DELETE_TABLES)
        await deleteAppRows(c, client, table, appId, true)
    }).catch(error => cloudlogErr({ requestId: c.get('requestId'), message: 'error deleting app rows', error, app_id: appId }))

    // Internal stats tables have restrictive RLS policies: delete on the service connection
    for (const table of ADMIN_DELETE_TABLES)
      await deleteAppRows(c, pg, table, appId, false)

    // Delete versions (last) - needs admin because no DELETE policy for anon role
    await deleteAppRows(c, pg, 'app_versions', appId, false)

    // Finally delete the app - needs admin because no DELETE policy for anon role
    try {
      await pg.query('DELETE FROM public.apps WHERE app_id = $1', [appId])
    }
    catch (dbError) {
      throw simpleError('cannot_delete_app', 'Cannot delete app', { supabaseError: dbError })
    }

    return appStoragePrefix
  }
  finally {
    closeClient(c, pg)
  }
}

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

  const appStoragePrefix = await deleteAppData(c, appId, apikey)

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
