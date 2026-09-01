import type { Database } from '../../utils/supabase.types.ts'
import { createHono, getBodyOrQuery, parseBody, quickError } from '../../utils/hono.ts'
import { version } from '../../utils/version.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { checkPermission, type Permission } from '../../utils/rbac.ts'
import { getAppOrganization } from '../../public/bundle/create.ts'
import {
  isAllowedActionOrg,
  isPayingOrg,
  isTrialOrg,
  supabaseApikey,
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

interface CheckPlanBody {
  org_id: string
  app_id?: string | null
  actions?: string[] | null
}

interface Check2faOrgBody {
  org_id: string
}

const PLAN_ACTIONS = ['mau', 'storage', 'bandwidth', 'build_time'] as const
type PlanAction = typeof PLAN_ACTIONS[number]

function isPlanAction(value: string): value is PlanAction {
  return (PLAN_ACTIONS as readonly string[]).includes(value)
}

function requireObjectBody<T extends object>(body: unknown): T | Response {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return quickError(400, 'invalid_json_body', 'Invalid JSON body', { body })
  return body as T
}

const CLI_APP_2FA_PERMISSIONS: Permission[] = [
  'app.read',
  'app.upload_bundle',
  'app.create_channel',
  'app.read_channels',
  'app.read_bundles',
  'bundle.delete',
  'app.delete',
  'app.update_settings',
  'app.build_native',
  'channel.read',
  'channel.delete',
  'channel.update_settings',
]

const CLI_ORG_2FA_PERMISSIONS: Permission[] = [
  'org.read',
  'org.update_settings',
  'org.read_members',
  'org.delete',
  'org.create_app',
]

async function hasAnyPermission(
  c: Parameters<typeof checkPermission>[0],
  permissions: Permission[],
  scope: { appId?: string, orgId?: string },
): Promise<boolean> {
  for (const permission of permissions) {
    if (await checkPermission(c, permission, scope))
      return true
  }
  return false
}

async function assertOrgUploadReadScope(
  c: Parameters<typeof checkPermission>[0],
  orgId: string,
  appId?: string | null,
): Promise<Response | null> {
  if (appId !== undefined && appId !== null) {
    if (typeof appId !== 'string' || !isValidAppId(appId))
      return quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })

    if (!(await checkPermission(c, 'app.upload_bundle', { appId })))
      return quickError(401, 'not_authorized', 'You cannot upload bundles for this app', { app_id: appId })

    const appWithOrg = await getAppOrganization(c, appId)
    if (appWithOrg.owner_org !== orgId)
      return quickError(403, 'org_mismatch', 'App does not belong to the requested organization', { org_id: orgId, app_id: appId })

    return null
  }

  if (!(await checkPermission(c, 'org.read', { orgId })))
    return quickError(401, 'not_authorized', 'You cannot read this organization', { org_id: orgId })

  return null
}

export const app = createHono('', version)

app.get('/user-id', middlewareKey(), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return c.json({ user_id: apikey.user_id })
})

app.post('/check-permission', middlewareKey(), async (c) => {
  const bodyResult = requireObjectBody<CheckPermissionBody>(await parseBody<unknown>(c))
  if (bodyResult instanceof Response)
    return bodyResult
  const body = bodyResult

  if (!body.permission_key || typeof body.permission_key !== 'string')
    return quickError(400, 'missing_permission_key', 'Missing permission_key', { body })

  const allowed = await checkPermission(c, body.permission_key as any, {
    orgId: body.org_id ?? undefined,
    appId: body.app_id ?? undefined,
    channelId: body.channel_id ?? undefined,
  })

  return c.json({ allowed: !!allowed })
})

app.post('/check-plan-upload', middlewareKey(), async (c) => {
  const bodyResult = requireObjectBody<CheckPlanUploadBody>(await parseBody<unknown>(c))
  if (bodyResult instanceof Response)
    return bodyResult
  const body = bodyResult

  if (!body.org_id || typeof body.org_id !== 'string')
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  const scopeError = await assertOrgUploadReadScope(c, body.org_id, body.app_id)
  if (scopeError)
    return scopeError

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const supabase = supabaseApikey(c, apikey.key ?? c.get('capgkey'))
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
  const body = await getBodyOrQuery<{ org_id?: string, cli_version?: string, app_id?: string }>(c)
  if (!body.org_id)
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  const scopeError = await assertOrgUploadReadScope(c, body.org_id, body.app_id)
  if (scopeError)
    return scopeError

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const apikeyString = apikey.key ?? c.get('capgkey')
  const supabase = supabaseApikey(c, apikeyString)
  const { data: messages, error } = await supabase
    .rpc('get_organization_cli_warnings', {
      orgid: body.org_id,
      cli_version: body.cli_version ?? '',
    })

  if (error)
    return quickError(500, 'cli_warnings_failed', 'Cannot load CLI warnings', { error })

  return c.json({ messages: messages ?? [] })
})

app.post('/check-2fa-app', middlewareKey(), async (c) => {
  const bodyResult = requireObjectBody<Check2faAppBody>(await parseBody<unknown>(c))
  if (bodyResult instanceof Response)
    return bodyResult
  const body = bodyResult

  if (!body.app_id || typeof body.app_id !== 'string')
    return quickError(400, 'missing_app_id', 'Missing app_id', { body })
  if (!isValidAppId(body.app_id))
    return quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })

  if (!(await hasAnyPermission(c, CLI_APP_2FA_PERMISSIONS, { appId: body.app_id })))
    return quickError(401, 'not_authorized', 'You cannot access this app', { app_id: body.app_id })

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const apikeyString = apikey.key ?? c.get('capgkey')
  const { data: shouldReject, error } = await supabaseApikey(c, apikeyString)
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
  const apikeyString = apikey.key ?? c.get('capgkey')
  const { data, error } = await supabaseApikey(c, apikeyString)
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
    return c.json({ channel: null, apikey_user_id: apikey.user_id })

  return c.json({ channel: data, apikey_user_id: apikey.user_id })
})

async function assertOrgPlanScope(
  c: Parameters<typeof checkPermission>[0],
  orgId: string,
  appId?: string | null,
): Promise<Response | null> {
  if (appId !== undefined && appId !== null) {
    if (typeof appId !== 'string' || !isValidAppId(appId))
      return quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })

    const allowed = await checkPermission(c, 'app.read', { appId })
      || await checkPermission(c, 'app.upload_bundle', { appId })
      || await checkPermission(c, 'bundle.delete', { appId })
    if (!allowed)
      return quickError(401, 'not_authorized', 'You cannot access this app', { app_id: appId })

    const appWithOrg = await getAppOrganization(c, appId)
    if (appWithOrg.owner_org !== orgId)
      return quickError(403, 'org_mismatch', 'App does not belong to the requested organization', { org_id: orgId, app_id: appId })

    return null
  }

  if (!(await checkPermission(c, 'org.read', { orgId })))
    return quickError(401, 'not_authorized', 'You cannot read this organization', { org_id: orgId })

  return null
}

async function resolvePlanResult(
  supabase: ReturnType<typeof supabaseApikey>,
  orgId: string,
  actions: PlanAction[],
  appId?: string | null,
): Promise<{ result: 'allowed' | 'billing_denied' | 'permission_denied' } | Response> {
  const orgScoped = await supabase.rpc('is_allowed_action_org_action', {
    orgid: orgId,
    actions,
  })
  if (orgScoped.error)
    return quickError(500, 'plan_check_failed', 'Cannot validate plan', { error: orgScoped.error })

  if (!appId) {
    return { result: orgScoped.data === true ? 'allowed' : 'billing_denied' }
  }

  const appScoped = await supabase.rpc('is_allowed_action_org_action', {
    orgid: orgId,
    actions,
    appid: appId,
  })
  if (appScoped.error)
    return quickError(500, 'plan_check_failed', 'Cannot validate plan', { error: appScoped.error })

  if (appScoped.data === true)
    return { result: 'allowed' }
  if (orgScoped.data === true)
    return { result: 'permission_denied' }
  return { result: 'billing_denied' }
}

app.get('/orgs', middlewareKey(), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const supabase = supabaseApikey(c, apikey.key ?? c.get('capgkey'))
  const { data, error } = await supabase.rpc('get_orgs_v7')
  if (error)
    return quickError(500, 'orgs_failed', 'Cannot load organizations', { error })

  return c.json({ orgs: data ?? [] })
})

app.post('/check-plan', middlewareKey(), async (c) => {
  const bodyResult = requireObjectBody<CheckPlanBody>(await parseBody<unknown>(c))
  if (bodyResult instanceof Response)
    return bodyResult
  const body = bodyResult

  if (!body.org_id || typeof body.org_id !== 'string')
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  const rawActions = body.actions
  let actions: PlanAction[] = [...PLAN_ACTIONS]
  if (rawActions != null) {
    if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.some(action => typeof action !== 'string' || !isPlanAction(action)))
      return quickError(400, 'invalid_actions', 'actions must be a non-empty list of mau, storage, bandwidth, or build_time', { body })
    actions = rawActions
  }

  const scopeError = await assertOrgPlanScope(c, body.org_id, body.app_id)
  if (scopeError)
    return scopeError

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const supabase = supabaseApikey(c, apikey.key ?? c.get('capgkey'))
  const planResult = await resolvePlanResult(supabase, body.org_id, actions, body.app_id)
  if (planResult instanceof Response)
    return planResult

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

  return c.json({
    result: planResult.result,
    valid: planResult.result === 'allowed',
    trial_days: trialDays,
    is_paying: isPaying,
    has_credits: creditsResult.data === true,
  })
})

app.post('/check-2fa-org', middlewareKey(), async (c) => {
  const bodyResult = requireObjectBody<Check2faOrgBody>(await parseBody<unknown>(c))
  if (bodyResult instanceof Response)
    return bodyResult
  const body = bodyResult

  if (!body.org_id || typeof body.org_id !== 'string')
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  if (!(await hasAnyPermission(c, CLI_ORG_2FA_PERMISSIONS, { orgId: body.org_id })))
    return quickError(401, 'not_authorized', 'You cannot access this organization', { org_id: body.org_id })

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const { data: shouldReject, error } = await supabaseApikey(c, apikey.key ?? c.get('capgkey'))
    .rpc('reject_access_due_to_2fa_for_org', { org_id: body.org_id })

  if (error)
    return quickError(500, 'check_2fa_failed', 'Cannot check 2FA compliance', { error })

  return c.json({ reject: shouldReject === true })
})

app.get('/org-member-compliance', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<{ org_id?: string }>(c)
  if (!body.org_id)
    return quickError(400, 'missing_org_id', 'Missing org_id', { body })

  if (!(await checkPermission(c, 'org.read_members', { orgId: body.org_id }))
    && !(await checkPermission(c, 'org.update_settings', { orgId: body.org_id }))) {
    return quickError(401, 'not_authorized', 'You cannot access this organization', { org_id: body.org_id })
  }

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const supabase = supabaseApikey(c, apikey.key ?? c.get('capgkey'))

  const [members2fa, membersPassword, caller2fa] = await Promise.all([
    supabase.rpc('check_org_members_2fa_enabled', { org_id: body.org_id }),
    supabase.rpc('check_org_members_password_policy', { org_id: body.org_id }),
    supabase.rpc('has_2fa_enabled'),
  ])

  return c.json({
    members_2fa: members2fa.error ? null : (members2fa.data ?? []),
    members_2fa_error: members2fa.error?.message ?? null,
    members_password: membersPassword.error ? null : (membersPassword.data ?? []),
    members_password_error: membersPassword.error?.message ?? null,
    caller_has_2fa: caller2fa.error ? null : caller2fa.data === true,
    caller_has_2fa_error: caller2fa.error?.message ?? null,
  })
})

app.get('/channel-current-bundle', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<{ app_id?: string, channel?: string }>(c)
  if (!body.app_id || !body.channel)
    return quickError(400, 'missing_fields', 'Missing app_id or channel', { body })
  if (!isValidAppId(body.app_id))
    return quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const supabase = supabaseApikey(c, apikey.key ?? c.get('capgkey'))
  const { data: channelRow, error: channelError } = await supabase
    .from('channels')
    .select('id, version')
    .eq('app_id', body.app_id)
    .eq('name', body.channel)
    .maybeSingle()

  if (channelError)
    return quickError(500, 'channel_lookup_failed', 'Cannot load channel', { error: channelError })
  if (!channelRow)
    return quickError(404, 'channel_not_found', 'Channel not found for app', { app_id: body.app_id, channel: body.channel })

  if (!(await checkPermission(c, 'channel.read', { appId: body.app_id, channelId: channelRow.id })))
    return quickError(401, 'not_authorized', 'You cannot read this channel', { app_id: body.app_id, channel: body.channel })

  if (!channelRow.version)
    return quickError(404, 'channel_has_no_bundle', 'Channel does not have a bundle linked', { app_id: body.app_id, channel: body.channel })

  const { data: bundleRows, error: bundleError } = await supabase.rpc('get_channel_current_bundle_rbac', {
    p_app_id: body.app_id,
    p_channel_id: channelRow.id,
  })

  if (bundleError)
    return quickError(500, 'channel_lookup_failed', 'Cannot load current bundle', { error: bundleError })

  const bundleName = bundleRows?.[0]?.bundle_name
  if (!bundleName)
    return quickError(404, 'channel_bundle_unreadable', 'Channel does not have a readable current bundle', { app_id: body.app_id, channel: body.channel })

  return c.json({ bundle_name: bundleName })
})
