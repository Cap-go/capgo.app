import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

interface GetDevice {
  app_id: string
  channel?: string
  page?: number
}

// Same columns and embeds as the PostgREST select it replaces; the embedded versions stay
// subject to app_versions RLS because the subselects run as the caller.
const CHANNEL_SELECT = `
  SELECT
    c.id,
    c.created_at,
    c.name,
    c.app_id,
    c.owner_org,
    c.created_by,
    c.updated_at,
    c.public,
    c.ios,
    c.android,
    c.disable_auto_update_under_native,
    c.disable_auto_update,
    c.update_package,
    c.allow_device_self_set,
    c.allow_emulator,
    c.allow_device,
    c.allow_dev,
    c.allow_prod,
    c.rollout_version,
    c.rollout_percentage_bps,
    c.rollout_enabled,
    c.rollout_id,
    c.rollout_paused_at,
    c.rollout_pause_reason,
    c.rollout_cache_ttl_seconds,
    c.paused_at,
    c.auto_pause_enabled,
    c.auto_pause_window_minutes,
    c.auto_pause_failure_rate_bps,
    c.auto_pause_confidence,
    c.auto_pause_min_attempts,
    c.auto_pause_min_failures,
    c.auto_pause_action,
    c.auto_pause_cooldown_minutes,
    c.auto_pause_last_triggered_at,
    c.auto_pause_last_checked_at,
    (SELECT pg_catalog.json_build_object('name', v.name, 'id', v.id) FROM public.app_versions v WHERE v.id = c.rollout_version) AS rollout_version_info,
    (SELECT pg_catalog.json_build_object('name', v.name, 'id', v.id) FROM public.app_versions v WHERE v.id = c.version) AS version
  FROM public.channels c`

type ChannelRow = Omit<Database['public']['Tables']['channels']['Row'], 'version'> & {
  rollout_version_info: { name: string, id: number } | null
  version: { name: string, id: number } | null
}

async function getAll(c: Context, body: GetDevice, apikey: Database['public']['Tables']['apikeys']['Row']) {
  // GET callers send page as a query string; coerce so (page + 1) is not string concatenation.
  const requestedPage = Math.trunc(Number(body.page ?? 0))
  const fetchOffset = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const from = fetchOffset * fetchLimit
  const to = (fetchOffset + 1) * fetchLimit - 1
  const principal = apikeyPrincipal(c, apikey.key)
  let dataChannels: ChannelRow[] | null = null
  let dbError: unknown = null
  try {
    dataChannels = await withRlsContext(c, principal, client => queryJson<ChannelRow>(
      client,
      `${CHANNEL_SELECT} WHERE c.app_id = $1 ORDER BY c.created_at ASC LIMIT $2 OFFSET $3`,
      [body.app_id, to - from + 1, from],
    ))
  }
  catch (error) {
    dbError = error
  }
  if (dbError || !dataChannels) {
    throw simpleError('cannot_find_channels', 'Cannot find channels', { supabaseError: dbError })
  }
  return c.json(dataChannels.map((o) => {
    const { disable_auto_update_under_native, disable_auto_update, update_package, rollout_percentage_bps, rollout_enabled, rollout_paused_at, rollout_pause_reason, rollout_cache_ttl_seconds, paused_at, auto_pause_enabled, auto_pause_window_minutes, auto_pause_failure_rate_bps, auto_pause_confidence, auto_pause_min_attempts, auto_pause_min_failures, auto_pause_action, auto_pause_cooldown_minutes, auto_pause_last_triggered_at, auto_pause_last_checked_at, ...rest } = o
    return {
      ...rest,
      disableAutoUpdateUnderNative: disable_auto_update_under_native,
      disableAutoUpdate: disable_auto_update,
      updatePackage: update_package,
      rolloutPercentageBps: rollout_percentage_bps,
      rolloutEnabled: rollout_enabled,
      rolloutPausedAt: rollout_paused_at,
      rolloutPauseReason: rollout_pause_reason,
      rolloutCacheTtlSeconds: rollout_cache_ttl_seconds,
      pausedAt: paused_at,
      autoPauseEnabled: auto_pause_enabled,
      autoPauseWindowMinutes: auto_pause_window_minutes,
      autoPauseFailureRateBps: auto_pause_failure_rate_bps,
      autoPauseConfidence: auto_pause_confidence,
      autoPauseMinAttempts: auto_pause_min_attempts,
      autoPauseMinFailures: auto_pause_min_failures,
      autoPauseAction: auto_pause_action,
      autoPauseCooldownMinutes: auto_pause_cooldown_minutes,
      autoPauseLastTriggeredAt: auto_pause_last_triggered_at,
      autoPauseLastCheckedAt: auto_pause_last_checked_at,
    }
  }))
}

async function getOne(c: Context, body: GetDevice, apikey: Database['public']['Tables']['apikeys']['Row']) {
  const principal = apikeyPrincipal(c, apikey.key)
  let dataChannel: ChannelRow | null = null
  let dbError: unknown = null
  try {
    const rows = await withRlsContext(c, principal, client => queryJson<ChannelRow>(
      client,
      `${CHANNEL_SELECT} WHERE c.app_id = $1 AND c.name = $2 LIMIT 2`,
      [body.app_id, body.channel!],
    ))
    // single(): zero or several matches are both errors.
    dataChannel = rows.length === 1 ? rows[0] : null
  }
  catch (error) {
    dbError = error
  }
  if (dbError || !dataChannel) {
    throw simpleError('cannot_find_version', 'Cannot find version', { supabaseError: dbError })
  }

  const { disable_auto_update_under_native, disable_auto_update, update_package, rollout_percentage_bps, rollout_enabled, rollout_paused_at, rollout_pause_reason, rollout_cache_ttl_seconds, paused_at, auto_pause_enabled, auto_pause_window_minutes, auto_pause_failure_rate_bps, auto_pause_confidence, auto_pause_min_attempts, auto_pause_min_failures, auto_pause_action, auto_pause_cooldown_minutes, auto_pause_last_triggered_at, auto_pause_last_checked_at, ...rest } = dataChannel
  const newObject = {
    ...rest,
    disableAutoUpdateUnderNative: disable_auto_update_under_native,
    disableAutoUpdate: disable_auto_update,
    updatePackage: update_package,
    rolloutPercentageBps: rollout_percentage_bps,
    rolloutEnabled: rollout_enabled,
    rolloutPausedAt: rollout_paused_at,
    rolloutPauseReason: rollout_pause_reason,
    rolloutCacheTtlSeconds: rollout_cache_ttl_seconds,
    pausedAt: paused_at,
    autoPauseEnabled: auto_pause_enabled,
    autoPauseWindowMinutes: auto_pause_window_minutes,
    autoPauseFailureRateBps: auto_pause_failure_rate_bps,
    autoPauseConfidence: auto_pause_confidence,
    autoPauseMinAttempts: auto_pause_min_attempts,
    autoPauseMinFailures: auto_pause_min_failures,
    autoPauseAction: auto_pause_action,
    autoPauseCooldownMinutes: auto_pause_cooldown_minutes,
    autoPauseLastTriggeredAt: auto_pause_last_triggered_at,
    autoPauseLastCheckedAt: auto_pause_last_checked_at,
  }

  return c.json(newObject)
}

export async function get(c: Context<MiddlewareKeyVariables>, body: GetDevice, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.read_channels', { appId: body.app_id }))) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id })
  }

  // get one channel or all channels
  if (body.channel) {
    return getOne(c, body, apikey)
  }
  return getAll(c, body, apikey)
}
