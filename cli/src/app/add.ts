import type { Buffer } from 'node:buffer'
import type { AppOptions } from '../schemas/app'
import type { Organization } from '../utils'
import { existsSync, readFileSync } from 'node:fs'
import { intro, log, outro } from '@clack/prompts'
import { getInvocationSource } from '../analytics/track'
import { checkAppExists, defaultAppIconPath, getAppIconStoragePath, newIconPath } from '../api/app'
import { checkAlerts } from '../api/update'
import {
  assertCliPermission,
  createSupabaseClient,
  findSavedKey,
  formatCapgoApiErrorBody,
  formatError,
  getAppId,
  getConfig,
  getContentType,
  getOrganizationWithPermission,
  resolveCapgoPublicApiHost,
  resolveUserIdFromApiKey,
  sendEvent,
} from '../utils'

export const reverseDomainRegex = /^[a-z0-9]+(\.[\w-]+)+$/i

function ensureOptions(appId: string, options: AppOptions, silent: boolean) {
  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new Error('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  if (appId.includes('--')) {
    if (!silent)
      log.error('The app id includes illegal symbols. You cannot use "--" in the app id')
    throw new Error('App id includes illegal symbols')
  }

  if (!reverseDomainRegex.test(appId)) {
    if (!silent) {
      log.error(`Invalid app ID format: "${appId}"`)
      log.info('App ID must be in reverse domain notation (e.g., com.example.app)')
      log.info('Valid format: lowercase letters, numbers, dots, hyphens, and underscores')
      log.info('Examples: com.mycompany.myapp, io.capgo.app, com.example.my-app')
    }
    throw new Error('Invalid app ID format')
  }
}

async function ensureAppDoesNotExist(
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>,
  appId: string,
  silent: boolean,
) {
  const appExist = await checkAppExists(supabase, appId)
  if (!appExist)
    return

  if (appId === 'io.ionic.starter') {
    if (!silent)
      log.error(`This appId ${appId} cannot be used it's reserved, please change it in your capacitor config.`)
    throw new Error('Reserved appId, please change it in capacitor config')
  }

  if (!silent)
    log.error(`App ${appId} already exist`)
  throw new Error(`App ${appId} already exists`)
}

export type AppCreateSource = 'cli-direct' | 'onboarding' | 'mcp'

export function resolveAppCreateSource(explicit?: AppCreateSource): AppCreateSource {
  if (explicit)
    return explicit
  return getInvocationSource() === 'mcp' ? 'mcp' : 'cli-direct'
}

async function createAppViaApi(
  apikey: string,
  params: {
    ownerOrg: string
    appId: string
    name: string
    iconUrl: string
    createdFromOnboarding: boolean
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
  const response = await fetch(`${apiHost}/app`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apikey,
      'capgkey': apikey,
    },
    body: JSON.stringify({
      owner_org: params.ownerOrg,
      app_id: params.appId,
      name: params.name,
      icon: params.iconUrl,
      need_onboarding: false,
      created_from_onboarding: params.createdFromOnboarding,
    }),
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const details = formatCapgoApiErrorBody(data) || `HTTP ${response.status}`
    throw new Error(details)
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

  await ensureAppDoesNotExist(supabase, appId, silent)

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
  let iconUrl = defaultAppIconPath

  // Icon upload is best-effort. Storage RLS issues must not block app creation;
  // the web onboarding path already continues without an icon on upload failure.
  if (iconBuff && iconType) {
    const { error } = await supabase.storage
      .from('images')
      .upload(iconPath, iconBuff, {
        contentType: iconType,
        upsert: true,
      })

    if (error) {
      if (!silent)
        log.warn(`Could not upload app icon (${formatError(error)}). Continuing with the default icon.`)
    }
    else {
      iconUrl = iconPath
    }
  }

  const appCreateSource = resolveAppCreateSource(source)

  try {
    // Use the same authorized API path as the web console. Direct PostgREST inserts
    // hit apps/storage RLS and fail for common API-key + pending-onboarding setups.
    await createAppViaApi(options.apikey!, {
      ownerOrg: organizationUid,
      appId,
      name,
      iconUrl,
      createdFromOnboarding: appCreateSource === 'onboarding',
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
  }
  catch (error) {
    const message = formatError(error)
    if (!silent)
      log.error(`Could not add app ${message}`)
    throw new Error(`Could not add app ${message}`)
  }

  await sendEvent(options.apikey!, {
    channel: 'app',
    event: 'App Created',
    icon: '🆕',
    org_id: organizationUid,
    tracking_version: 2,
    tags: { 'app-id': appId, 'source': appCreateSource },
    notify: false,
    notifyConsole: true,
  }).catch(() => {})

  if (!silent) {
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
