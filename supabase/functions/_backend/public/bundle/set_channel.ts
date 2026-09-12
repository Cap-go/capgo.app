import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { HTTPException } from 'hono/http-exception'
import { throwIfChannelUpdatePackageMismatch } from '../../utils/channel_update_package.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { checkPermissionPg } from '../../utils/rbac.ts'
import { isValidAppId } from '../../utils/utils.ts'

export type SetChannelTarget = 'auto' | 'stable' | 'rollout'

export interface SetChannelBody {
  app_id: string
  version_id: number
  channel_id: number
  target?: SetChannelTarget
}

interface ChannelRow {
  name: string
  owner_org: string
  version: number | null
  rollout_version: number | null
  rollout_enabled: boolean
}

export function channelHasProgressiveRollout(channel: Pick<ChannelRow, 'rollout_enabled' | 'rollout_version'>) {
  return channel.rollout_enabled || channel.rollout_version != null
}

export function resolveSetChannelTarget(
  channel: Pick<ChannelRow, 'rollout_enabled' | 'rollout_version'>,
  requestedTarget: SetChannelTarget = 'auto',
): 'stable' | 'rollout' {
  if (requestedTarget === 'stable')
    return 'stable'
  if (requestedTarget === 'rollout')
    return 'rollout'
  return channelHasProgressiveRollout(channel) ? 'rollout' : 'stable'
}

export interface PgQueryClient {
  query: <TRow = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rowCount?: number | null, rows: TRow[] }>
  release: () => void
}


export interface SetChannelResult {
  channelName: string
  versionName: string
  assignmentTarget: 'stable' | 'rollout'
}

type DrizzleClient = ReturnType<typeof getDrizzleClient>

function validateSetChannelBody(body: SetChannelBody) {
  if (!body.app_id || !body.version_id || !body.channel_id) {
    throw simpleError('missing_required_fields', 'Missing required fields', { app_id: body.app_id, version_id: body.version_id, channel_id: body.channel_id })
  }

  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
}

function getEffectiveApikey(c: Context<MiddlewareKeyVariables>, apikey: Database['public']['Tables']['apikeys']['Row']) {
  const effectiveApikey = apikey.key ?? c.get('capgkey')
  if (!effectiveApikey) {
    throw simpleError('cannot_set_bundle_to_channel', 'Cannot set bundle to channel', { error: 'Missing API key context for audit logging' })
  }
  return effectiveApikey
}

async function fetchTargetChannel(dbClient: PgQueryClient, body: SetChannelBody) {
  const channelResult = await dbClient.query<ChannelRow>(
    `SELECT name,
            owner_org,
            version,
            rollout_version,
            rollout_enabled
     FROM public.channels
     WHERE id = $1
       AND app_id = $2
     FOR UPDATE`,
    [body.channel_id, body.app_id],
  )

  return (channelResult.rowCount ?? 0) === 1 ? channelResult.rows[0] : null
}

async function fetchVersionName(dbClient: PgQueryClient, body: SetChannelBody) {
  const versionResult = await dbClient.query<{ name: string }>(
    `SELECT name
     FROM public.app_versions
     WHERE id = $1
       AND app_id = $2
       AND deleted = false`,
    [body.version_id, body.app_id],
  )

  if ((versionResult.rowCount ?? 0) !== 1) {
    throw simpleError('cannot_find_version', 'Cannot find version')
  }
  return versionResult.rows[0].name
}

async function updateChannelVersion(dbClient: PgQueryClient, body: SetChannelBody, channelOwnerOrg: string) {
  const updateResult = await dbClient.query(
    `UPDATE public.channels
     SET version = $1
     WHERE id = $2
       AND app_id = $3
       AND owner_org = $4
     RETURNING id`,
    [body.version_id, body.channel_id, body.app_id, channelOwnerOrg],
  )

  if ((updateResult.rowCount ?? 0) !== 1) {
    throw new Error('Channel update affected 0 rows')
  }
}

async function updateChannelRolloutVersion(dbClient: PgQueryClient, body: SetChannelBody, channelOwnerOrg: string) {
  const updateResult = await dbClient.query(
    `UPDATE public.channels
     SET rollout_version = $1,
         rollout_enabled = true
     WHERE id = $2
       AND app_id = $3
       AND owner_org = $4
     RETURNING id`,
    [body.version_id, body.channel_id, body.app_id, channelOwnerOrg],
  )

  if ((updateResult.rowCount ?? 0) !== 1) {
    throw new Error('Channel rollout update affected 0 rows')
  }
}

export async function assertCanPromoteChannelInTransaction(
  c: Context<MiddlewareKeyVariables>,
  body: SetChannelBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  dbClient: PgQueryClient,
  checkAppScope = false,
) {
  const drizzle = getDrizzleClient(dbClient as unknown as ReturnType<typeof getPgClient>) as DrizzleClient
  const canPromote = await checkPermissionPg(
    c,
    'channel.promote_bundle',
    checkAppScope ? { appId: body.app_id } : { appId: body.app_id, channelId: body.channel_id },
    drizzle,
    apikey.user_id,
    getEffectiveApikey(c, apikey),
  )

  if (!canPromote) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id, channel_id: body.channel_id })
  }
}

export async function setChannelInTransaction(
  c: Context<MiddlewareKeyVariables>,
  body: SetChannelBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  dbClient: PgQueryClient,
): Promise<SetChannelResult> {
  validateSetChannelBody(body)

  const channel = await fetchTargetChannel(dbClient, body)
  await assertCanPromoteChannelInTransaction(c, body, apikey, dbClient, channel === null)

  // The preview-delete route takes this same transaction-scoped lock before
  // checking references and soft-deleting the bundle.
  await dbClient.query(
    'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',
    [body.version_id],
  )
  const versionName = await fetchVersionName(dbClient, body)

  if (!channel) {
    throw simpleError('cannot_find_channel', 'Cannot find channel')
  }

  const assignmentTarget = resolveSetChannelTarget(channel, body.target)
  if (assignmentTarget === 'rollout' && !channel.version) {
    throw simpleError(
      'cannot_set_rollout_without_stable',
      'Cannot set rollout target because this channel has no stable bundle yet',
      { channel_id: body.channel_id },
    )
  }

  await dbClient.query(
    'SELECT set_config(\'request.headers\', $1, true)',
    [JSON.stringify({ capgkey: getEffectiveApikey(c, apikey) })],
  )
  if (assignmentTarget === 'rollout')
    await updateChannelRolloutVersion(dbClient, body, channel.owner_org)
  else
    await updateChannelVersion(dbClient, body, channel.owner_org)

  return {
    channelName: channel.name,
    versionName,
    assignmentTarget,
  }
}

export async function setChannel(c: Context<MiddlewareKeyVariables>, body: SetChannelBody, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  const pgClient = getPgClient(c)
  let dbClient: PgQueryClient | null = null
  let transactionStarted = false
  let result: SetChannelResult | null = null
  try {
    dbClient = await pgClient.connect()
    await dbClient.query('BEGIN')
    transactionStarted = true
    result = await setChannelInTransaction(c, body, apikey, dbClient)
    await dbClient.query('COMMIT')
  }
  catch (error) {
    if (dbClient && transactionStarted) {
      try {
        await dbClient.query('ROLLBACK')
      }
      catch {
        // Ignore rollback failures to preserve the original database error.
      }
    }
    if (error instanceof HTTPException)
      throw error
    throwIfChannelUpdatePackageMismatch(error)
    logPgError(c, 'set_channel_update', error)
    throw simpleError('cannot_set_bundle_to_channel', 'Cannot set bundle to channel', { error: (error as Error)?.message })
  }
  finally {
    dbClient?.release()
    await closeClient(c, pgClient)
  }

  const message = result!.assignmentTarget === 'rollout'
    ? `Bundle ${result!.versionName} set as rollout target on channel ${result!.channelName}`
    : `Bundle ${result!.versionName} set to channel ${result!.channelName}`

  return c.json({
    status: 'success',
    message,
    assignmentTarget: result!.assignmentTarget,
  })
}
