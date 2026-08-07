import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { log } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { formatCapgoApiErrorBody, getCapgoCliHttpStatus, getPMAndCommand, hasCliPermission, invokeCapgoCliApi, resolveCapgoPublicApiHost, show2FADeniedError } from '../utils'

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
  const response = await fetch(`${apiHost}/app/${encodeURIComponent(appId)}`, {
    method: 'PUT',
headers: buildCliRequestHeaders({ 'Content-Type': 'application/json', Authorization: apikey, capgkey: apikey }),
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
      const exists = await checkAppExists(apikey, appid, options)
      return { appid, exists }
    }),
  )
  return results
}

export async function check2FAComplianceForApp(
  supabase: SupabaseClient<Database>,
  appid: string,
  silent = false,
): Promise<void> {
  // TODO(cli-http): no Capgo HTTP equivalent for reject_access_due_to_2fa_for_app yet
  // Use the new reject_access_due_to_2fa_for_app function
  // This handles getting the org, user identity (JWT or API key), and checking 2FA compliance
  const { data: shouldReject, error: rejectError } = await supabase
    .rpc('reject_access_due_to_2fa_for_app', { app_id: appid })

  if (rejectError) {
    if (!silent)
      log.error(`Cannot check 2FA compliance: ${rejectError.message}`)
    throw new Error(`Cannot check 2FA compliance: ${rejectError.message}`)
  }

  if (shouldReject) {
    if (silent) {
      throw new Error('2FA required for this organization')
    }
    show2FADeniedError()
  }
}

export async function checkAppExistsAndHasPermissionOrgErr(
  supabase: SupabaseClient<Database>,
  apikey: string,
  appid: string,
  requiredPermissionKey: string,
  silent = false,
  skip2FACheck = false,
  channelId?: number | null,
) {
  const pm = getPMAndCommand()
  const isChannelScopedPermission = channelId != null && requiredPermissionKey.startsWith('channel.')

  // Check 2FA compliance first (unless already checked earlier)
  if (!skip2FACheck)
    await check2FAComplianceForApp(supabase, appid, silent)

  if (!isChannelScopedPermission && !(await checkAppExists(apikey, appid))) {
    const msg = `App ${appid} does not exist, run first \`${pm.runner} @capgo/cli app add ${appid}\` to create it`
    if (!silent)
      log.error(msg)
    throw new Error(msg)
  }

  if (!(await hasCliPermission(supabase, apikey, requiredPermissionKey, { appId: appid, channelId: channelId ?? null }))) {
    const msg = `Insufficient permissions for app ${appid}. Required RBAC permission for this action: ${requiredPermissionKey}.`
    if (!silent)
      log.error(msg)
    throw new Error(msg)
  }

  return true
}

export type { AppOptions as Options } from '../schemas/app'

export const newIconPath = 'assets/icon.png'
export const defaultAppIconPath = 'public/capgo.png'

export function resolveAppSetIconPath(explicitIcon?: string): string | undefined {
  return explicitIcon
}

export function getAppIconStoragePath(organizationUid: string, appId: string) {
  return `org/${organizationUid}/${appId}/icon`
}
