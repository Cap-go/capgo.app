import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { HTTPException } from 'hono/http-exception'
import { BRES, simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

export interface ChannelSet {
  app_id: string
  channel: string
  version?: string
  public?: boolean
  disableAutoUpdateUnderNative?: boolean
  disableAutoUpdate?: Database['public']['Enums']['disable_update']
  ios?: boolean
  android?: boolean
  allow_device_self_set?: boolean
  allow_emulator?: boolean
  allow_device?: boolean
  allow_dev?: boolean
  allow_prod?: boolean
  delete_bundle?: boolean
}

interface PgQueryClient {
  query: <TRow = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rowCount?: number | null, rows: TRow[] }>
  release: () => void
}

interface PreviewChannelRow {
  id: number
  app_id: string
  owner_org: string
  rbac_id: string
  version: number | null
  rollout_version: number | null
}

interface PreviewVersionRow {
  id: number
  created_by_apikey_rbac_id: string | null
}

interface OwnerOrgRow {
  owner_org: string
}

function getEffectiveApikey(c: Context<MiddlewareKeyVariables>, apikey: Database['public']['Tables']['apikeys']['Row']) {
  const effectiveApikey = apikey.key ?? c.get('capgkey')
  if (!effectiveApikey) {
    throw simpleError('cannot_access_app', 'You can\'t access this app')
  }
  return effectiveApikey
}

async function loadPreviewChannelForUpdate(dbClient: PgQueryClient, body: ChannelSet) {
  const result = await dbClient.query<PreviewChannelRow>(
    `SELECT id, app_id, owner_org, rbac_id, version, rollout_version
     FROM public.channels
     WHERE app_id = $1
       AND name = $2
     FOR UPDATE`,
    [body.app_id, body.channel],
  )

  return (result.rowCount ?? 0) === 1 ? result.rows[0] : null
}

async function loadPreviewChannelOwner(dbClient: PgQueryClient, body: ChannelSet) {
  const result = await dbClient.query<OwnerOrgRow>(
    `SELECT owner_org
     FROM public.channels
     WHERE app_id = $1
       AND name = $2`,
    [body.app_id, body.channel],
  )

  return (result.rowCount ?? 0) === 1 ? result.rows[0] : null
}

async function loadPreviewAppForUpdate(dbClient: PgQueryClient, appId: string) {
  const result = await dbClient.query<OwnerOrgRow>(
    `SELECT owner_org
     FROM public.apps
     WHERE app_id = $1
     FOR UPDATE`,
    [appId],
  )

  return (result.rowCount ?? 0) === 1 ? result.rows[0] : null
}

async function lockPreviewBundleLifecycle(dbClient: PgQueryClient, versionIds: number[]) {
  for (const versionId of [...versionIds].sort((left, right) => left - right)) {
    await dbClient.query(
      'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',
      [versionId],
    )
  }
}

async function assertPreviewChannelDeletePermission(
  c: Context<MiddlewareKeyVariables>,
  dbClient: PgQueryClient,
  body: ChannelSet,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  effectiveApikey: string,
  channel: PreviewChannelRow,
) {
  if (!(await checkPermission(c, 'channel.delete', { appId: body.app_id, channelId: channel.id }))) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id, channel_id: channel.id })
  }

  const permission = await dbClient.query<{ allowed: boolean }>(
    `SELECT public.rbac_check_permission_direct(
       public.rbac_perm_channel_delete(),
       $1::uuid,
       $2::uuid,
       $3::varchar,
       $4::bigint,
       $5::text
     ) AS allowed`,
    [apikey.user_id, channel.owner_org, body.app_id, channel.id, effectiveApikey],
  )
  if (permission.rows[0]?.allowed !== true) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id, channel_id: channel.id })
  }

  const binding = await dbClient.query(
    `SELECT child_binding.id
     FROM public.role_bindings AS child_binding
     INNER JOIN public.roles AS child_role
       ON child_role.id = child_binding.role_id
       AND child_role.scope_type = child_binding.scope_type
     INNER JOIN public.role_bindings AS parent_binding
       ON parent_binding.id = child_binding.parent_binding_id
     INNER JOIN public.roles AS parent_role
       ON parent_role.id = parent_binding.role_id
       AND parent_role.scope_type = parent_binding.scope_type
     WHERE child_binding.principal_type = public.rbac_principal_apikey()
       AND child_binding.principal_id = $1::uuid
       AND child_binding.scope_type = public.rbac_scope_channel()
       AND child_binding.org_id = $2::uuid
       AND child_binding.channel_id = $3::uuid
       AND child_binding.is_direct IS FALSE
       AND child_role.name = 'channel_preview'
       AND parent_binding.principal_type = child_binding.principal_type
       AND parent_binding.principal_id = child_binding.principal_id
       AND parent_binding.scope_type = public.rbac_scope_app()
       AND parent_binding.org_id = child_binding.org_id
       AND parent_binding.app_id = child_binding.app_id
       AND parent_role.name = 'app_preview'
       AND (parent_binding.expires_at IS NULL OR parent_binding.expires_at > pg_catalog.now())
     LIMIT 1
     FOR KEY SHARE OF child_binding, parent_binding`,
    [apikey.rbac_id, channel.owner_org, channel.rbac_id],
  )
  if ((binding.rowCount ?? 0) !== 1) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id, channel_id: channel.id })
  }
}

async function deletePreviewChannelAndBundle(
  c: Context<MiddlewareKeyVariables>,
  body: ChannelSet,
  apikey: Database['public']['Tables']['apikeys']['Row'],
) {
  const effectiveApikey = getEffectiveApikey(c, apikey)
  const pgClient = getPgClient(c)
  let dbClient: PgQueryClient | null = null
  let transactionStarted = false

  try {
    dbClient = await pgClient.connect()
    await dbClient.query('BEGIN')
    transactionStarted = true

    const expectedChannel = await loadPreviewChannelOwner(dbClient, body)
    if (!expectedChannel) {
      throw simpleError('cannot_find_channel', 'Cannot find channel')
    }

    // Keep the organization, app, channel, then bundle lock order. Org deletion
    // takes the org lock before its cascades, and app transfers update the app
    // before versions and channels. The initial lookup stays unlocked to avoid a cycle.
    await dbClient.query(
      'SELECT public.lock_rbac_orgs($1::uuid)',
      [expectedChannel.owner_org],
    )

    const app = await loadPreviewAppForUpdate(dbClient, body.app_id)
    if (!app) {
      throw simpleError('cannot_find_channel', 'Cannot find channel')
    }
    if (app.owner_org !== expectedChannel.owner_org) {
      throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id })
    }

    const channel = await loadPreviewChannelForUpdate(dbClient, body)
    if (!channel) {
      throw simpleError('cannot_find_channel', 'Cannot find channel')
    }
    if (channel.owner_org !== app.owner_org) {
      throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id, channel_id: channel.id })
    }

    await assertPreviewChannelDeletePermission(c, dbClient, body, apikey, effectiveApikey, channel)

    const versionIds = [...new Set([channel.version, channel.rollout_version].filter((version): version is number => version !== null))]
    await lockPreviewBundleLifecycle(dbClient, versionIds)
    const versions = versionIds.length === 0
      ? []
      : (await dbClient.query<PreviewVersionRow>(
          `SELECT id, created_by_apikey_rbac_id
           FROM public.app_versions
           WHERE id = ANY($1::bigint[])
             AND app_id = $2
             AND owner_org = $3::uuid
             AND deleted = false
           FOR UPDATE`,
          [versionIds, channel.app_id, channel.owner_org],
        )).rows

    if (versions.some(version => version.created_by_apikey_rbac_id !== apikey.rbac_id)) {
      throw simpleError('cannot_delete_preview_bundle', 'This API key can only delete its own preview bundle')
    }

    const activeVersionIds = versions.map(version => version.id)
    if (activeVersionIds.length > 0) {
      const linkedElsewhere = await dbClient.query(
        `SELECT 1
         FROM public.channels
         WHERE app_id = $1
           AND id <> $2
           AND (
             version = ANY($3::bigint[])
             OR rollout_version = ANY($3::bigint[])
           )
         LIMIT 1`,
        [channel.app_id, channel.id, activeVersionIds],
      )
      if ((linkedElsewhere.rowCount ?? 0) > 0) {
        throw simpleError('cannot_delete_linked_version', 'Cannot delete a bundle linked to another channel')
      }
    }

    await dbClient.query(
      'SELECT set_config(\'request.headers\', $1, true)',
      [JSON.stringify({ capgkey: effectiveApikey })],
    )

    const deletedChannel = await dbClient.query<{ id: number }>(
      `DELETE FROM public.channels
       WHERE id = $1
         AND app_id = $2
       RETURNING id`,
      [channel.id, channel.app_id],
    )
    if ((deletedChannel.rowCount ?? 0) !== 1) {
      throw new Error('Preview channel deletion affected 0 rows')
    }

    if (activeVersionIds.length > 0) {
      const deletedVersions = await dbClient.query<{ id: number }>(
        `UPDATE public.app_versions
         SET deleted = true
         WHERE id = ANY($1::bigint[])
           AND app_id = $2
           AND owner_org = $3::uuid
           AND deleted = false
           AND created_by_apikey_rbac_id = $4::uuid
         RETURNING id`,
        [activeVersionIds, channel.app_id, channel.owner_org, apikey.rbac_id],
      )
      if ((deletedVersions.rowCount ?? 0) !== activeVersionIds.length) {
        throw new Error('Preview bundle deletion affected an unexpected number of rows')
      }
    }

    await dbClient.query('COMMIT')
  }
  catch (error) {
    if (dbClient && transactionStarted) {
      try {
        await dbClient.query('ROLLBACK')
      }
      catch {
        // Preserve the original error when rollback itself fails.
      }
    }
    if (error instanceof HTTPException)
      throw error
    logPgError(c, 'delete_preview_channel_and_bundle', error)
    throw simpleError('cannot_delete_preview_bundle', 'Cannot delete this preview channel and bundle')
  }
  finally {
    dbClient?.release()
    await closeClient(c, pgClient)
  }
}

export async function deleteChannel(c: Context<MiddlewareKeyVariables>, body: ChannelSet, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  if (!body.channel) {
    throw simpleError('missing_channel_name', 'You must provide a channel name')
  }

  if (body.delete_bundle === true) {
    await deletePreviewChannelAndBundle(c, body, apikey)
    return c.json(BRES)
  }

  const supabase = supabaseApikey(c, apikey.key)

  // Search for the exact channel before checking its channel-scoped permission.
  const { data: dataChannel, error: dbError } = await supabase
    .from('channels')
    .select('id')
    .eq('app_id', body.app_id)
    .eq('name', body.channel)
    .single()
  if (dbError || !dataChannel) {
    throw simpleError('cannot_find_channel', 'Cannot find channel', { supabaseError: dbError })
  }

  if (!(await checkPermission(c, 'channel.delete', { appId: body.app_id, channelId: dataChannel.id }))) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id, channel_id: dataChannel.id })
  }

  const { data: deletedChannels, error: deleteError } = await supabase
    .from('channels')
    .delete()
    .eq('id', dataChannel.id)
    .eq('app_id', body.app_id)
    .eq('name', body.channel)
    .select('id')

  if (deleteError || !deletedChannels || deletedChannels.length !== 1) {
    throw simpleError('cannot_delete_channel', 'Cannot delete channel', { supabaseError: deleteError })
  }

  return c.json(BRES)
}
