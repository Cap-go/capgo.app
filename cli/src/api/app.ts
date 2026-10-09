import type { CapgoClient } from '../utils'
import type { Database } from '../types/supabase.types'
import { log } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { CliUserError } from '../shared/cli-user-error'
import { runCliPreflight } from './preflight'
import { formatCapgoApiErrorBody, formatCapgoCliInvokeError, getCapgoCliHttpStatus, invokeCapgoCliApi, readCapgoCliApiErrorPayload, resolveCapgoPublicApiHost } from '../utils'

export async function checkAppExists(
  apikey: string,
  appid: string,
  options?: { apiHost?: string },
  silent = true,
) {
  const { data, error } = await invokeCapgoCliApi(`app/${encodeURIComponent(appid)}`, {
    apikey,
    method: 'GET',
    body: undefined,
    apiHost: options?.apiHost,
  })
  if (error) {
    const status = getCapgoCliHttpStatus(error)
    if (status === 404)
      return false
    if (status === 401 || status === 403) {
      const message = 'Cannot access app. Check that your API key is valid and has app.read permission for this app.'
      if (!silent)
        log.error(message)
      throw new CliUserError(
        message,
        { appId: appid, requiredPermissionKey: 'app.read' },
      )
    }
    throw new Error(`Cannot check app access: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
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
  options?: { apiHost?: string },
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
        apiHost: options?.apiHost,
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
  options?: { apiHost?: string },
): Promise<ExistingOrganizationApp | null> {
  const { data, error } = await invokeCapgoCliApi<ExistingOrganizationApp>(`app/${encodeURIComponent(appId)}`, {
    apikey,
    method: 'GET',
    body: undefined,
    apiHost: options?.apiHost,
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
  _supabase: CapgoClient,
  orgId: string,
  appId: string,
  apikey: string,
  options?: { apiHost?: string },
): Promise<void> {
  // Prefer Capgo API host (or self-hosted /functions/v1) with the API key so
  // org.create_app keys can finish pending onboarding without app.update_settings.
  const apiHost = await resolveCapgoPublicApiHost(options)
  const response = await fetch(`${apiHost}/app/${encodeURIComponent(appId)}`, {
    method: 'PUT',
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': apikey,
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
  options?: { apiHost?: string },
): Promise<void> {
  const apiHost = await resolveCapgoPublicApiHost(options)
  const response = await fetch(`${apiHost}/app/${encodeURIComponent(appId)}`, {
    method: 'PUT',
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': apikey,
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
  options?: { apiHost?: string },
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

/** Fail unless the org 2FA policy lets this key act on the app. */
export async function check2FAComplianceForApp(
  client: CapgoClient,
  appid: string,
  silent = false,
): Promise<void> {
  await runCliPreflight(client, { appId: appid }, { silent, telemetryFunctionName: 'check2FAComplianceForApp' })
}

/**
 * Fail unless the app exists for this key and the key holds `requiredPermissionKey`
 * (2FA policy included unless `skip2FACheck`). One backend preflight call.
 */
export async function checkAppExistsAndHasPermissionOrgErr(
  client: CapgoClient,
  _apikey: string,
  appid: string,
  requiredPermissionKey: string,
  silent = false,
  skip2FACheck = false,
  channelId?: number | null,
) {
  await runCliPreflight(client, {
    appId: appid,
    channelId,
    permission: requiredPermissionKey,
    check2fa: !skip2FACheck,
  }, {
    silent,
    permissionDeniedMessage: `Insufficient permissions for app ${appid}. Required RBAC permission for this action: ${requiredPermissionKey}.`,
    permissionDeniedErrorMessage: `Insufficient permissions for app. Required RBAC permission for this action: ${requiredPermissionKey}.`,
    telemetryFunctionName: 'checkAppExistsAndHasPermissionOrgErr',
  })
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

export interface UploadAppIconResult {
  path?: string
  conflict?: boolean
  error?: Error | null
}

export async function uploadAppIconHttp(
  apikey: string,
  params: {
    appId: string
    orgId: string
    contentBase64: string
    contentType: string
    upsert?: boolean
    apiHost?: string
  },
): Promise<UploadAppIconResult> {
  const { data, error } = await invokeCapgoCliApi<{ path?: string, conflict?: boolean }>(
    'private/cli/storage/icon',
    {
      apikey,
      method: 'POST',
      body: {
        app_id: params.appId,
        org_id: params.orgId,
        content_base64: params.contentBase64,
        content_type: params.contentType,
        upsert: params.upsert === true,
      },
      apiHost: params.apiHost,
    },
  )

  if (error) {
    if (getCapgoCliHttpStatus(error) === 409) {
      const payload = await readCapgoCliApiErrorPayload(error) as { path?: string } | null
      return {
        path: payload?.path ?? getAppIconStoragePath(params.orgId, params.appId),
        conflict: true,
        error: null,
      }
    }
    return { error }
  }

  return { path: data?.path, conflict: data?.conflict === true, error: null }
}
