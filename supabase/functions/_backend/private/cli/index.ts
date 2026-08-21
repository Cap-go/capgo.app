import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { getBodyOrQuery, parseBody, quickError } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { checkPermission } from '../../utils/rbac.ts'
import {
  isAllowedActionOrg,
  isPayingOrg,
  isTrialOrg,
  supabaseAdmin,
} from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

interface CheckPermissionBody {
  permission_key: string
  org_id?: string | null
  app_id?: string | null
  channel_id?: number | null
}

interface CheckPlanUploadBody {
  org_id: string
  app_id?: string | null
}

interface Check2faAppBody {
  app_id: string
}

interface UploadChannelQuery {
  app_id: string
  channel: string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.get('/user-id', middlewareKey(), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return c.json({ user_id: apikey.user_id })
})

app.post('/check-permission', middlewareKey(), async (c) => {
  const body = await parseBody<CheckPermissionBody>(c)
  if (!body.permission_key)
    return quickError(400, 'missing_permission_key', 'Missing permission_key', { body })

  const allowed = await checkPermission(c, body.permission_key as any, {
    orgId: body.org_id ?? undefined,
    appId: body.app_id ?? undefined,
    channelId: body.channel_id ?? undefined,
  })

  return c.json({ allowed: !!allowed })
})

app.post('/check-plan-upload', middlewareKey(), async (c) => {
  const body = await parseBody<CheckPlanUploadBody>(c)
  if (!body.org_id)
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  const supabase = supabaseAdmin(c)
  const validPlan = body.app_id
    ? await (async () => {
        const { data, error } = await supabase.rpc('is_allowed_action_org_action', {
          orgid: body.org_id,
          actions: ['storage'],
          appid: body.app_id,
        })
        if (error)
          return quickError(500, 'plan_check_failed', 'Cannot validate upload plan', { error })
        return data === true
      })()
    : await isAllowedActionOrg(c, body.org_id)

  if (typeof validPlan !== 'boolean')
    return validPlan

  const creditsArgs = body.app_id
    ? { orgid: body.org_id, appid: body.app_id }
    : { orgid: body.org_id }

  const [trialDays, isPaying, creditsResult] = await Promise.all([
    isTrialOrg(c, body.org_id),
    isPayingOrg(c, body.org_id),
    supabase.rpc('has_usage_credits_org', creditsArgs).single(),
  ])

  if (creditsResult.error)
    return quickError(500, 'plan_check_failed', 'Cannot validate upload credits', { error: creditsResult.error })

  const hasCredits = creditsResult.data === true

  return c.json({
    valid: validPlan,
    trial_days: trialDays,
    is_paying: isPaying,
    has_credits: hasCredits,
  })
})

app.get('/warnings', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<{ org_id?: string, cli_version?: string }>(c)
  if (!body.org_id)
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  const { data: messages, error } = await supabaseAdmin(c)
    .rpc('get_organization_cli_warnings', {
      orgid: body.org_id,
      cli_version: body.cli_version ?? '',
    })

  if (error)
    return quickError(500, 'cli_warnings_failed', 'Cannot load CLI warnings', { error })

  return c.json({ messages: messages ?? [] })
})

app.post('/check-2fa-app', middlewareKey(), async (c) => {
  const body = await parseBody<Check2faAppBody>(c)
  if (!body.app_id)
    return quickError(400, 'missing_app_id', 'Missing app_id', { body })
  if (!isValidAppId(body.app_id))
    return quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })

  const { data: shouldReject, error } = await supabaseAdmin(c)
    .rpc('reject_access_due_to_2fa_for_app', { app_id: body.app_id })

  if (error)
    return quickError(500, 'check_2fa_failed', 'Cannot check 2FA compliance', { error })

  return c.json({ reject: shouldReject === true })
})

app.get('/upload-channel', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<UploadChannelQuery>(c)
  if (!body.app_id || !body.channel)
    return quickError(400, 'missing_fields', 'Missing app_id or channel', { body })
  if (!isValidAppId(body.app_id))
    return quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id })))
    return quickError(401, 'not_authorized', 'You cannot upload bundles for this app', { app_id: body.app_id })

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const { data, error } = await supabaseAdmin(c)
    .from('channels')
    .select(`
      id,
      public,
      version,
      rollout_version,
      rollout_enabled,
      rollout_percentage_bps,
      disable_auto_update,
      version_info:app_versions!channels_version_fkey(
        id,
        name,
        deleted,
        checksum,
        min_update_version,
        native_packages
      )
    `)
    .eq('app_id', body.app_id)
    .eq('name', body.channel)
    .maybeSingle()

  if (error)
    return quickError(500, 'channel_lookup_failed', 'Cannot load channel for upload', { error })

  if (!data)
    return c.json({ channel: null })

  return c.json({ channel: data, apikey_user_id: apikey.user_id })
})
