import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { log } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { CliUserError } from '../shared/cli-user-error'
import { isTransientNetworkError } from '../shared/network-error'
import {
  callTwoFactorComplianceRpcWithRetry,
  throwTwoFactorComplianceRpcError,
  warnAndContinueTwoFactorPreflightNetworkFailure,
} from '../shared/two-factor-compliance'
import { appAddHintMessage, formatCapgoApiErrorBody, formatCapgoCliApiError, getCapgoCliHttpStatus, hasCliPermission, hasCliPermissionViaHttp, invokeCapgoCliApi, isCapgoManagedSupabaseHost, resolveCapgoPublicApiHost, show2FADeniedError, type CapgoCliHostOptions } from '../utils'

export async function checkAppExists(
  apikey: string,
  appid: string,
  options?: { supaHost?: string, supaAnon?: string },
) {
  const { data, error } = await invokeCapgoCliApi(`app/${encodeURIComponent(appid)}`, {
    apikey,
    method: 'GET',
    body: undefined,
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })
  if (error) {
    if (getCapgoCliHttpStatus(error) === 404)
      return false
    throw error
  }
  return !!data
}

export type PendingOnboardingApp = Pick<
  Database['public']['Tables']['apps']['Row'],
  'app_id' | 'name' | 'icon_url' | 'need_onboarding' | 'existing_app' | 'ios_store_url' | 'android_store_url'
>

export type ExistingOrganizationApp = Pick<
  Database['public']['Tables']['apps']['Row'],
  'app_id' | 'name' | 'owner_org' | 'need_onboarding'
>


export async function listPendingOnboardingApps(
  apikey: string,
  orgId: string,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<PendingOnboardingApp[]> {
  const apps: PendingOnboardingApp[] = []
  let page = 0
  while (true) {
    const { data, error } = await invokeCapgoCliApi<Array<PendingOnboardingApp & { created_at?: string }>>(
      `app?org_id=${encodeURIComponent(orgId)}&page=${page}`,
      {
        apikey,
        method: 'GET',
        body: undefined,
        supaHost: options?.supaHost,
        supaAnon: options?.supaAnon,
      },
    )
    if (error) {
      throw new Error(`Could not load pending onboarding apps: ${error.message}`)
    }
    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    apps.push(...batch.filter(app => app.need_onboarding === true))
    if (batch.length < 50)
      break
    page += 1
  }
  return apps
}

export async function findAppInOrganization(
  apikey: string,
  orgId: string,
  appId: string,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<ExistingOrganizationApp | null> {
  const { data, error } = await invokeCapgoCliApi<ExistingOrganizationApp>(`app/${encodeURIComponent(appId)}`, {
    apikey,
    method: 'GET',
    body: undefined,
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })
  if (error) {
    if (getCapgoCliHttpStatus(error) === 404)
      return null
    throw new Error(`Could not check existing app ${appId} in org ${orgId}: ${error.message}`)
  }
  if (!data || data.owner_org !== orgId)
    return null
  return {
    app_id: data.app_id,
    name: data.name,
    owner_org: data.owner_org,
    need_onboarding: data.need_onboarding ?? false,
  }
}

export async function completePendingOnboardingApp(
  _supabase: SupabaseClient<Database>,
  orgId: string,
  appId: string,
  apikey: string,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<void> {
  // Prefer Capgo API host (or self-hosted /functions/v1) with the API key so
  // org.create_app keys can finish pending onboarding without app.update_settings.
  const apiHost = await resolveCapgoPublicApiHost(options)
  const usesFunctionsV1 = apiHost.includes('/functions/v1')
  const authorization = usesFunctionsV1 && options?.supaAnon
    ? `Bearer ${options.supaAnon}`
    : apikey
  const response = await fetch(`${apiHost}/app/${encodeURIComponent(appId)}`, {
    method: 'PUT',
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': authorization,
      'capgkey': apikey,
    }),
    body: JSON.stringify({
      need_onboarding: false,
    }),
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const details = formatCapgoApiErrorBody(data) || `HTTP ${response.status}`
    throw new Error(`Could not complete onboarding for app ${appId}: ${details}`)
  }

  if (!(data as { app_id?: string } | null)?.app_id) {
    throw new Error(`Could not complete onboarding for app ${appId} in org ${orgId}: app was not found or is no longer pending onboarding`)
  }
}

export interface AppOnboardingProgressPatch {
  source?: 'manual' | 'cli' | 'mcp' | 'ai'
  outcome?: 'in_progress' | 'completed' | 'skipped' | 'switched_to_manual'
  steps?: Record<string, { status: 'done' | 'skipped', at?: string }>
}

export async function reportAppOnboardingProgress(
  apikey: string,
  appId: string,
  onboarding: AppOnboardingProgressPatch,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<void> {
  const apiHost = await resolveCapgoPublicApiHost(options)
  const usesFunctionsV1 = apiHost.includes('/functions/v1')
  const authorization = usesFunctionsV1 && options?.supaAnon
    ? `Bearer ${options.supaAnon}`
    : apikey
  const response = await fetch(`${apiHost}/app/${encodeURIComponent(appId)}`, {
    method: 'PUT',
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': authorization,
      'capgkey': apikey,
    }),
    body: JSON.stringify({ onboarding }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const details = formatCapgoApiErrorBody(data) || `HTTP ${response.status}`
    throw new Error(`Could not report onboarding progress for app ${appId}: ${details}`)
  }
}

/**
 * Check multiple app IDs at once for batch validation (e.g., for suggestions)
 */
export async function checkAppIdsExist(
  apikey: string,
  appids: string[],
  options?: { supaHost?: string, supaAnon?: string },
) {
  const results = await Promise.all(
    appids.map(async (appid) => {
      try {
        const exists = await checkAppExists(apikey, appid, options)
        return { appid, exists }
      }
      catch {
        // Keep suggestion generation resilient to transient lookup failures.
        return { appid, exists: false }
      }
    }),
  )
  return results
}

function isSupabaseClient(value: unknown): value is SupabaseClient<Database> {
  return typeof value === 'object' && value !== null
}

export async function check2FAComplianceForApp(
  apikeyOrSupabase: string | SupabaseClient<Database>,
  appid: string,
  silent = false,
  options?: CapgoCliHostOptions,
): Promise<void> {
  if (typeof apikeyOrSupabase !== 'string') {
    const { data: shouldReject, error: rejectError } = await callTwoFactorComplianceRpcWithRetry(() =>
      apikeyOrSupabase.rpc('reject_access_due_to_2fa_for_app', { app_id: appid }),
    )

    if (rejectError) {
      if (!silent && !isTransientNetworkError(rejectError))
        log.error(`Cannot check 2FA compliance: ${rejectError.message}`)
      if (isTransientNetworkError(rejectError)) {
        await warnAndContinueTwoFactorPreflightNetworkFailure({
          silent,
          telemetryFunctionName: 'check2FAComplianceForApp',
        })
        return
      }
      throwTwoFactorComplianceRpcError(rejectError)
    }

    if (shouldReject) {
      if (silent)
        throw new Error('2FA required for this organization')
      show2FADeniedError()
    }
    return
  }

  const { data, error } = await callTwoFactorComplianceRpcWithRetry<{ reject?: boolean }>(() =>
    invokeCapgoCliApi<{ reject?: boolean }>('private/cli/check-2fa-app', {
      apikey: apikeyOrSupabase,
      method: 'POST',
      body: { app_id: appid },
      supaHost: options?.supaHost,
      supaAnon: options?.supaAnon,
    }),
  )

  if (error) {
    if (!silent && !isTransientNetworkError(error))
      log.error(`Cannot check 2FA compliance: ${await formatCapgoCliApiError(error)}`)
    if (isTransientNetworkError(error)) {
      await warnAndContinueTwoFactorPreflightNetworkFailure({
        silent,
        telemetryFunctionName: 'check2FAComplianceForApp',
      })
      return
    }
    const msg = await formatCapgoCliApiError(error)
    throw new Error(`Cannot check 2FA compliance: ${msg}`)
  }

  if (data?.reject) {
    if (silent) {
      throw new Error('2FA required for this organization')
    }
    show2FADeniedError()
  }
}

function hostOptionsFromSupabase(supabase: SupabaseClient<Database>) {
  // supabase-js keeps these as protected fields; local/self-host tests still
  // need the same host when Capgo HTTP existence checks replace PostgREST RPCs.
  // Hosted Capgo clients must keep default api.capgo.app resolution — their
  // supabaseUrl points at PostgREST, not the public Capgo HTTP API.
  const client = supabase as SupabaseClient<Database> & { supabaseUrl?: string, supabaseKey?: string }
  const supaHost = typeof client.supabaseUrl === 'string' ? client.supabaseUrl : undefined
  const supaAnon = typeof client.supabaseKey === 'string' ? client.supabaseKey : undefined
  if (supaHost && supaAnon && !isCapgoManagedSupabaseHost(supaHost))
    return { supaHost, supaAnon }
  return undefined
}

// lgtm[js/insecure-randomness] Permission gate only; this module does not generate secrets or tokens with Math.random.
export async function checkAppExistsAndHasPermissionOrgErr(
  apikeyOrSupabase: string | SupabaseClient<Database>,
  appidOrApikey: string,
  requiredPermissionKeyOrAppid?: string,
  optionsOrSilent?: (CapgoCliHostOptions & { silent?: boolean, skip2FACheck?: boolean, channelId?: number | null }) | boolean | string,
  skip2FACheckOrSilent?: boolean,
  channelIdOrSkip2FA?: number | null | boolean,
  channelId?: number | null,
) {
  let apikey: string
  let appid: string
  let requiredPermissionKey: string
  let silent: boolean
  let skip2FACheck: boolean
  let resolvedChannelId: number | null
  let hostOptions: CapgoCliHostOptions | undefined

  if (isSupabaseClient(apikeyOrSupabase)) {
    apikey = appidOrApikey
    appid = requiredPermissionKeyOrAppid!
    requiredPermissionKey = optionsOrSilent as string
    silent = skip2FACheckOrSilent ?? false
    skip2FACheck = channelIdOrSkip2FA === true
    resolvedChannelId = typeof channelId === 'number' ? channelId : null
    hostOptions = hostOptionsFromSupabase(apikeyOrSupabase)
  }
  else if (typeof optionsOrSilent === 'object' && optionsOrSilent !== null) {
    apikey = apikeyOrSupabase
    appid = appidOrApikey
    requiredPermissionKey = requiredPermissionKeyOrAppid!
    silent = optionsOrSilent.silent ?? false
    skip2FACheck = optionsOrSilent.skip2FACheck ?? false
    resolvedChannelId = optionsOrSilent.channelId ?? null
    hostOptions = optionsOrSilent
  }
  else {
    apikey = apikeyOrSupabase
    appid = appidOrApikey
    requiredPermissionKey = requiredPermissionKeyOrAppid!
    silent = typeof optionsOrSilent === 'boolean' ? optionsOrSilent : false
    skip2FACheck = skip2FACheckOrSilent ?? false
    resolvedChannelId = typeof channelIdOrSkip2FA === 'number' ? channelIdOrSkip2FA : (channelId ?? null)
  }

  const isChannelScopedPermission = resolvedChannelId != null && requiredPermissionKey.startsWith('channel.')

  if (!skip2FACheck) {
    if (isSupabaseClient(apikeyOrSupabase))
      await check2FAComplianceForApp(apikeyOrSupabase, appid, silent)
    else
      await check2FAComplianceForApp(apikey, appid, silent, hostOptions)
  }

  if (!isChannelScopedPermission && !(await checkAppExists(apikey, appid, hostOptions))) {
    const msg = appAddHintMessage(appid)
    if (!silent)
      log.error(msg)
    throw new Error(msg)
  }

  const allowed = await (isSupabaseClient(apikeyOrSupabase)
    ? hasCliPermission(apikeyOrSupabase, apikey, requiredPermissionKey, { appId: appid, channelId: resolvedChannelId })
    : hasCliPermissionViaHttp(apikey, requiredPermissionKey, { appId: appid, channelId: resolvedChannelId }, hostOptions))

  if (!allowed) {
    const userMessage = `Insufficient permissions for app ${appid}. Required RBAC permission for this action: ${requiredPermissionKey}.`
    if (!silent)
      log.error(userMessage)
    throw new CliUserError(
      `Insufficient permissions for app. Required RBAC permission for this action: ${requiredPermissionKey}.`,
      { appId: appid, requiredPermissionKey },
    )
  }

  return true
}

export type { AppOptions as Options } from '../schemas/app'

export const newIconPath = 'assets/icon.png'

export function resolveAppSetIconPath(explicitIcon?: string): string | undefined {
  return explicitIcon
}

export function getAppIconStoragePath(organizationUid: string, appId: string) {
  return `org/${organizationUid}/${appId}/icon`
}
