import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

interface GetDevice {
  app_id: string
  channel?: string
  page?: number
}

async function getAll(c: Context, body: GetDevice, apikey: Database['public']['Tables']['apikeys']['Row']) {
  const fetchOffset = body.page ?? 0
  const from = fetchOffset * fetchLimit
  const to = (fetchOffset + 1) * fetchLimit - 1
  const { data: dataChannels, error: dbError } = await supabaseApikey(c, apikey.key)
    .from('channels')
    .select(`
      id,
      created_at,
      name,
      app_id,
      created_by,
      updated_at,
      public,
      disable_auto_update_under_native,
      disable_auto_update,
      allow_device_self_set,
      allow_emulator,
      allow_device,
      allow_dev,
      allow_prod,

      rollout_version,
      rollout_percentage_bps,
      rollout_enabled,
      rollout_id,
      rollout_paused_at,
      rollout_pause_reason,
      rollout_cache_ttl_seconds,
      auto_pause_enabled,
      auto_pause_window_minutes,
      auto_pause_failure_rate_bps,
      auto_pause_confidence,
      auto_pause_min_attempts,
      auto_pause_min_failures,
      auto_pause_action,
      auto_pause_cooldown_minutes,
      auto_pause_last_triggered_at,
      auto_pause_last_checked_at,
      rollout_version_info:app_versions!channels_rollout_version_fkey(
        name,
        id
      ),
      version:app_versions!channels_version_fkey(
        name,
        id
      )
  `)
    .eq('app_id', body.app_id)
    .range(from, to)
    .order('created_at', { ascending: true })
  if (dbError || !dataChannels) {
    throw simpleError('cannot_find_channels', 'Cannot find channels', { supabaseError: dbError })
  }
  return c.json(dataChannels.map((o) => {
    const { disable_auto_update_under_native, disable_auto_update, rollout_percentage_bps, rollout_enabled, rollout_paused_at, rollout_pause_reason, rollout_cache_ttl_seconds, auto_pause_enabled, auto_pause_window_minutes, auto_pause_failure_rate_bps, auto_pause_confidence, auto_pause_min_attempts, auto_pause_min_failures, auto_pause_action, auto_pause_cooldown_minutes, auto_pause_last_triggered_at, auto_pause_last_checked_at, ...rest } = o
    return {
      ...rest,
      disableAutoUpdateUnderNative: disable_auto_update_under_native,
      disableAutoUpdate: disable_auto_update,
      rolloutPercentageBps: rollout_percentage_bps,
      rolloutEnabled: rollout_enabled,
      rolloutPausedAt: rollout_paused_at,
      rolloutPauseReason: rollout_pause_reason,
      rolloutCacheTtlSeconds: rollout_cache_ttl_seconds,
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
  const { data: dataChannel, error: dbError } = await supabaseApikey(c, apikey.key)
    .from('channels')
    .select(`
    id,
    created_at,
    name,
    app_id,
    created_by,
    updated_at,
    public,
    disable_auto_update_under_native,
    disable_auto_update,
    allow_device_self_set,
    allow_emulator,
    allow_device,
    allow_dev,
    allow_prod,
    public,

        rollout_version,
        rollout_percentage_bps,
        rollout_enabled,
        rollout_id,
        rollout_paused_at,
        rollout_pause_reason,
        rollout_cache_ttl_seconds,
        auto_pause_enabled,
        auto_pause_window_minutes,
        auto_pause_failure_rate_bps,
        auto_pause_confidence,
        auto_pause_min_attempts,
        auto_pause_min_failures,
        auto_pause_action,
        auto_pause_cooldown_minutes,
        auto_pause_last_triggered_at,
        auto_pause_last_checked_at,
        rollout_version_info:app_versions!channels_rollout_version_fkey(
          name,
          id
        ),
    version:app_versions!channels_version_fkey(
      name,
      id
    )
  `)
    .eq('app_id', body.app_id)
    .eq('name', body.channel!)
    .single()
  if (dbError || !dataChannel) {
    throw simpleError('cannot_find_version', 'Cannot find version', { supabaseError: dbError })
  }

  const { disable_auto_update_under_native, disable_auto_update, rollout_percentage_bps, rollout_enabled, rollout_paused_at, rollout_pause_reason, rollout_cache_ttl_seconds, auto_pause_enabled, auto_pause_window_minutes, auto_pause_failure_rate_bps, auto_pause_confidence, auto_pause_min_attempts, auto_pause_min_failures, auto_pause_action, auto_pause_cooldown_minutes, auto_pause_last_triggered_at, auto_pause_last_checked_at, ...rest } = dataChannel
  const newObject = {
    ...rest,
    disableAutoUpdateUnderNative: disable_auto_update_under_native,
    disableAutoUpdate: disable_auto_update,
    rolloutPercentageBps: rollout_percentage_bps,
    rolloutEnabled: rollout_enabled,
    rolloutPausedAt: rollout_paused_at,
    rolloutPauseReason: rollout_pause_reason,
    rolloutCacheTtlSeconds: rollout_cache_ttl_seconds,
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
