import type { Buffer } from 'node:buffer'
import type { AppOptions } from '../schemas/app'
import type { Organization } from '../utils'
import { existsSync, readFileSync } from 'node:fs'
import { intro, log, outro } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { getInvocationSource, trackEvent } from '../analytics/track'
import { getAppIconStoragePath, newIconPath } from '../api/app'
import { getAppListPath } from './list'
import { checkAlerts } from '../api/update'
import { isAiAgentEnvironment } from '../init/onboarding-source'
import { CliUserError } from '../shared/cli-user-error'
import {
  assertCliPermission,
  createSupabaseClient,
  findSavedKey,
  formatCapgoApiErrorBody,
  formatError,
  getAppId,
  getCapgoCliHttpStatus,
  getConfig,
  getContentType,
  getOrganizationWithPermission,
  invokeCapgoCliApi,
  resolveCapgoPublicApiHost,
  resolveUserIdFromApiKey,
  sendEvent,
} from '../utils'

export const reverseDomainRegex = /^[a-z0-9]+(\.[\w-]+)+$/i

function ensureOptions(appId: string, options: AppOptions, silent: boolean) {
  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new CliUserError('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new CliUserError('Missing appId')
  }

  if (appId === 'io.ionic.starter') {
    if (!silent)
      log.error(`This appId ${appId} cannot be used it's reserved, please change it in your capacitor config.`)
    throw new CliUserError('Reserved appId, please change it in capacitor config')
  }

  if (appId.includes('--')) {
    if (!silent)
      log.error('The app id includes illegal symbols. You cannot use "--" in the app id')
    throw new CliUserError('App id includes illegal symbols')
  }

  if (!reverseDomainRegex.test(appId)) {
    if (!silent) {
      log.error(`Invalid app ID format: "${appId}"`)
      log.info('App ID must be in reverse domain notation (e.g., com.example.app)')
      log.info('Valid format: lowercase letters, numbers, dots, hyphens, and underscores')
      log.info('Examples: com.mycompany.myapp, io.capgo.app, com.example.my-app')
    }
    throw new CliUserError('Invalid app ID format')
  }
}

export type AppCreateSource = 'cli-direct' | 'onboarding' | 'mcp'

export function resolveAppCreateSource(explicit?: AppCreateSource): AppCreateSource {
  if (explicit)
    return explicit
  return getInvocationSource() === 'mcp' ? 'mcp' : 'cli-direct'
}

export function isStorageObjectConflict(error: unknown) {
  if (!error || typeof error !== 'object')
    return false

  const { status, statusCode } = error as { status?: unknown, statusCode?: unknown }
  return status === 409 || statusCode === '409'
}

export function isDuplicateAppCreateError(error: unknown, httpStatus?: number) {
  if (httpStatus === 409)
    return true
  const message = formatError(error).toLowerCase()
  return message.includes('app_id_already_exists') || message.includes('app id already exists')
}

export type AppAddDuplicateOutcome = 'duplicate_owned' | 'duplicate_taken' | 'not_duplicate'

type AppListRow = { app_id?: string }

async function isAppListedInOrganization(
  apikey: string,
  appId: string,
  ownerOrg: string,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<boolean | null> {
  let page = 0
  while (true) {
    const { data, error } = await invokeCapgoCliApi<AppListRow[]>(
      getAppListPath(page, ownerOrg),
      {
        apikey,
        method: 'GET',
        body: undefined,
        supaHost: options?.supaHost,
        supaAnon: options?.supaAnon,
      },
    )

    if (error) {
      const status = getCapgoCliHttpStatus(error)
      if (status === 400 || status === 401 || status === 403)
        return null
      throw error
    }

    const batch = Array.isArray(data) ? data : []
    if (batch.some(row => row.app_id === appId))
      return true
    if (batch.length < 50)
      return false
    page += 1
  }
}

async function isAppInTargetOrganization(
  apikey: string,
  appId: string,
  ownerOrg: string,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<boolean | null> {
  const { data, error } = await invokeCapgoCliApi<{ owner_org?: string }>(
    `app/${encodeURIComponent(appId)}`,
    {
      apikey,
      method: 'GET',
      body: undefined,
      supaHost: options?.supaHost,
      supaAnon: options?.supaAnon,
    },
  )

  if (error) {
    const status = getCapgoCliHttpStatus(error)
    if (status === 404)
      return false
    if (status === 401 || status === 403)
      return null
    throw error
  }

  return data?.owner_org === ownerOrg
}

async function isDuplicateAppOwnedByCaller(
  params: {
    apikey: string
    appId: string
    ownerOrg: string
    supaHost?: string
    supaAnon?: string
  },
  deps: {
    isAppInTargetOrganization?: typeof isAppInTargetOrganization
    isAppListedInOrganization?: typeof isAppListedInOrganization
  } = {},
): Promise<boolean> {
  const lookup = deps.isAppInTargetOrganization ?? isAppInTargetOrganization
  const appInTargetOrg = await lookup(
    params.apikey,
    params.appId,
    params.ownerOrg,
    { supaHost: params.supaHost, supaAnon: params.supaAnon },
  )

  if (appInTargetOrg === true)
    return true
  if (appInTargetOrg === false)
    return false

  const listAppsInOrg = deps.isAppListedInOrganization ?? isAppListedInOrganization
  const listedInOrg = await listAppsInOrg(
    params.apikey,
    params.appId,
    params.ownerOrg,
    { supaHost: params.supaHost, supaAnon: params.supaAnon },
  )
  if (listedInOrg === true)
    return true
  if (listedInOrg === false)
    return false

  throw new Error('Cannot verify app ownership for this API key. Grant app.read or org.read, then retry.')
}

export async function resolveAppAddDuplicateOutcome(
  params: {
    apikey: string
    appId: string
    ownerOrg: string
    createError: unknown
    httpStatus?: number
    supaHost?: string
    supaAnon?: string
  },
  deps: {
    isAppInTargetOrganization?: typeof isAppInTargetOrganization
    isAppListedInOrganization?: typeof isAppListedInOrganization
  } = {},
): Promise<AppAddDuplicateOutcome> {
  if (!isDuplicateAppCreateError(params.createError, params.httpStatus))
    return 'not_duplicate'

  try {
    const owned = await isDuplicateAppOwnedByCaller(params, deps)
    return owned ? 'duplicate_owned' : 'duplicate_taken'
  }
  catch (error) {
    throw new Error(formatError(error))
  }
}

async function createAppViaApi(
  apikey: string,
  params: {
    ownerOrg: string
    appId: string
    name: string
    iconUrl?: string
    createdFromOnboarding: boolean
    onboardingSource?: 'cli' | 'mcp' | 'ai'
    supaHost?: string
    supaAnon?: string
  },
) {
  // Prefer Capgo API host (or self-hosted /functions/v1) with the API key.
  // Avoid supabase.functions.invoke: it always sends Authorization: Bearer <anon>.
  const apiHost = await resolveCapgoPublicApiHost({
    supaHost: params.supaHost,
    supaAnon: params.supaAnon,
  })
  const usesFunctionsV1 = apiHost.includes('/functions/v1')
  const authorization = usesFunctionsV1 && params.supaAnon
    ? `Bearer ${params.supaAnon}`
    : apikey
  const response = await fetch(`${apiHost}/app`, {
    method: 'POST',
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': authorization,
      'capgkey': apikey,
    }),
    body: JSON.stringify({
      owner_org: params.ownerOrg,
      app_id: params.appId,
      name: params.name,
      ...(params.iconUrl ? { icon: params.iconUrl } : {}),
      need_onboarding: false,
      created_from_onboarding: params.createdFromOnboarding,
      onboarding: params.onboardingSource
        ? { source: params.onboardingSource, outcome: 'in_progress' }
        : undefined,
    }),
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const details = formatCapgoApiErrorBody(data) || `HTTP ${response.status}`
    const error = new Error(details) as Error & { httpStatus?: number }
    error.httpStatus = response.status
    throw error
  }

  const createdAppId = (data as { app_id?: string } | null)?.app_id
  if (!createdAppId) {
    throw new Error('App create API returned no app_id')
  }

  return data as { app_id: string, icon_url?: string, name?: string }
}

export async function addAppInternal(
  initialAppId: string,
  options: AppOptions,
  organization?: Organization,
  silent = false,
  source?: AppCreateSource,
) {
  if (!silent)
    intro('Adding')

  if (!silent)
    await checkAlerts()

  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig()
  const appId = getAppId(initialAppId, extConfig?.config)

  ensureOptions(appId, options, silent)

  const supabase = await createSupabaseClient(options.apikey!, options.supaHost, options.supaAnon)
  const userId = await resolveUserIdFromApiKey(supabase, options.apikey)

  if (!organization)
    organization = await getOrganizationWithPermission(supabase, options.apikey, 'org.create_app')

  const organizationUid = organization.gid

  await assertCliPermission(supabase, options.apikey, 'org.create_app', { orgId: organizationUid }, {
    message: `Insufficient permissions to create an app in organization ${organizationUid}`,
    silent,
  })

  let { name, icon } = options
  name = name || extConfig.config?.appName || 'Unknown'
  icon = icon || 'resources/icon.png'

  if (!icon || !name) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId and a name, or be in a capacitor project')
    throw new Error('Missing app name or icon path')
  }

  if (!silent)
    log.info(`Adding ${appId} to Capgo`)

  let iconBuff: Buffer | null = null
  let iconType: string | null = null

  if (existsSync(icon)) {
    iconBuff = readFileSync(icon)
    const contentType = getContentType(icon)
    iconType = contentType || 'image/png'
    if (!silent)
      log.warn(`Found app icon ${icon}`)
  }
  else if (existsSync(newIconPath)) {
    iconBuff = readFileSync(newIconPath)
    const contentType = getContentType(newIconPath)
    iconType = contentType || 'image/png'
    if (!silent)
      log.warn(`Found app icon ${newIconPath}`)
  }
  else if (!silent) {
    log.warn(`Cannot find app icon in any of the following locations: ${icon}, ${newIconPath}`)
  }

  const iconPath = getAppIconStoragePath(organizationUid, appId)
  let iconUrl: string | undefined

  // Icon upload is best-effort. Storage RLS issues must not block app creation;
  // the web onboarding path already continues without an icon on upload failure.
  if (iconBuff && iconType) {
    // TODO(cli-http): icon upload still requires supabase storage
    const { error } = await supabase.storage
      .from('images')
      .upload(iconPath, iconBuff, {
        contentType: iconType,
        // A duplicate app add must not overwrite the existing app's icon before POST returns 409.
        upsert: false,
      })

    if (error && !isStorageObjectConflict(error)) {
      if (!silent)
        log.warn(`Could not upload app icon (${formatError(error)}). Continuing without an icon.`)
    }
    else {
      // A conflict can be an orphaned icon from an earlier attempt whose POST failed.
      // Reusing its path is safe because upsert:false did not mutate the stored object,
      // and POST /app remains authoritative for duplicate app IDs.
      iconUrl = iconPath
    }
  }

  const appCreateSource = resolveAppCreateSource(source)
  const onboardingSource = appCreateSource === 'mcp'
    ? 'mcp'
    : isAiAgentEnvironment() ? 'ai' : 'cli'

  let appAlreadyExists = false
  try {
    // Use the same authorized API path as the web console. Direct PostgREST inserts
    // hit apps/storage RLS and fail for common API-key + pending-onboarding setups.
    await createAppViaApi(options.apikey!, {
      ownerOrg: organizationUid,
      appId,
      name,
      iconUrl,
      createdFromOnboarding: appCreateSource === 'onboarding',
      onboardingSource,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
  }
  catch (error) {
    let duplicateOutcome: AppAddDuplicateOutcome
    try {
      duplicateOutcome = await resolveAppAddDuplicateOutcome({
        apikey: options.apikey!,
        appId,
        ownerOrg: organizationUid,
        createError: error,
        httpStatus: (error as { httpStatus?: number }).httpStatus,
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      })
    }
    catch (ownershipError) {
      const message = formatError(ownershipError)
      if (!silent)
        log.error(`Could not add app ${message}`)
      throw new Error(`Could not add app ${message}`)
    }

    if (duplicateOutcome === 'duplicate_owned') {
      appAlreadyExists = true
    }
    else if (duplicateOutcome === 'duplicate_taken') {
      const takenMessage = `App ID ${appId} is already taken`
      if (!silent)
        log.error(`Could not add app: ${takenMessage}`)
      throw new Error(`Could not add app: ${takenMessage}`)
    }
    else {
      const message = formatError(error)
      if (!silent)
        log.error(`Could not add app ${message}`)
      throw new Error(`Could not add app ${message}`)
    }
  }

  if (appAlreadyExists) {
    void trackEvent({
      channel: 'app',
      event: 'CLI Recovered App Already Exists',
      appId,
      apikey: options.apikey!,
      orgId: organizationUid,
      tags: { source: appCreateSource },
    })
  }
  else {
    await sendEvent(options.apikey!, {
      channel: 'app',
      event: 'App Created',
      icon: '🆕',
      org_id: organizationUid,
      tracking_version: 2,
      tags: { 'app-id': appId, 'source': appCreateSource },
      notifyConsole: true,
    }).catch(() => {})
  }

  if (!silent) {
    if (appAlreadyExists)
      log.success(`App ${appId} already exists in Capgo`)
    else
      log.success(`App ${appId} added to Capgo`)
    log.info(`This app is accessible to all members of your organization based on their permissions`)
    log.info(`Next step: upload a bundle with "npx @capgo/cli bundle upload ${appId}"`)
    outro('Done ✅')
  }

  return {
    appId,
    organizationUid,
    userId,
    name,
    iconUrl,
    signedURL: iconUrl,
  }
}

export async function addApp(appId: string, options: AppOptions) {
  await addAppInternal(appId, options, undefined)
}
