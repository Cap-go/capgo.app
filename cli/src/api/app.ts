import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/supabase.types'
import { log } from '@clack/prompts'
import { formatCapgoApiErrorBody, getPMAndCommand, hasCliPermission, resolveCapgoPublicApiHost, show2FADeniedError } from '../utils'

export async function checkAppExists(supabase: SupabaseClient<Database>, appid: string) {
  const { data: app } = await supabase
    .rpc('exist_app_v2', { appid })
    .single()
  return !!app
}

export type PendingOnboardingApp = Pick<
  Database['public']['Tables']['apps']['Row'],
  'app_id' | 'name' | 'icon_url' | 'need_onboarding' | 'existing_app' | 'ios_store_url' | 'android_store_url'
>

export type ExistingOrganizationApp = Pick<
  Database['public']['Tables']['apps']['Row'],
  'app_id' | 'name' | 'owner_org' | 'need_onboarding'
>

function isMissingOnboardingSchemaError(error: { message?: string, details?: string, hint?: string, code?: string | null } | null) {
  if (!error)
    return false

  const text = [error.message, error.details, error.hint, error.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return [
    'need_onboarding',
    'existing_app',
    'ios_store_url',
    'android_store_url',
    'column',
    'schema cache',
    'pgrst204',
    '42703',
  ].some(token => text.includes(token))
}

export async function listPendingOnboardingApps(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<PendingOnboardingApp[]> {
  const { data, error } = await supabase
    .from('apps')
    .select('app_id, name, icon_url, need_onboarding, existing_app, ios_store_url, android_store_url')
    .eq('owner_org', orgId)
    .eq('need_onboarding', true)
    .order('created_at', { ascending: false })

  if (error) {
    if (isMissingOnboardingSchemaError(error)) {
      return []
    }

    throw new Error(`Could not load pending onboarding apps: ${error.message}`)
  }

  return data ?? []
}

export async function findAppInOrganization(
  supabase: SupabaseClient<Database>,
  orgId: string,
  appId: string,
): Promise<ExistingOrganizationApp | null> {
  const { data, error } = await supabase
    .from('apps')
    .select('app_id, name, owner_org, need_onboarding')
    .eq('owner_org', orgId)
    .eq('app_id', appId)
    .maybeSingle()

  if (error) {
    if (isMissingOnboardingSchemaError(error)) {
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('apps')
        .select('app_id, name, owner_org')
        .eq('owner_org', orgId)
        .eq('app_id', appId)
        .maybeSingle()

      if (fallbackError) {
        throw new Error(`Could not check existing app ${appId} in org ${orgId}: ${fallbackError.message}`)
      }

      return fallbackData ? { ...fallbackData, need_onboarding: false } : null
    }

    throw new Error(`Could not check existing app ${appId} in org ${orgId}: ${error.message}`)
  }

  return data ?? null
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apikey,
      'capgkey': apikey,
    },
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
export async function checkAppIdsExist(supabase: SupabaseClient<Database>, appids: string[]) {
  const results = await Promise.all(
    appids.map(async (appid) => {
      const { data: app } = await supabase
        .rpc('exist_app_v2', { appid })
        .single()
      return { appid, exists: !!app }
    }),
  )
  return results
}

export async function check2FAComplianceForApp(
  supabase: SupabaseClient<Database>,
  appid: string,
  silent = false,
): Promise<void> {
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

  if (!isChannelScopedPermission && !(await checkAppExists(supabase, appid))) {
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
