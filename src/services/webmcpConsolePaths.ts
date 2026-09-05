import type { WebMcpConsolePage } from '~/types/webmcp'

export const CONSOLE_PAGES: WebMcpConsolePage[] = [
  'dashboard',
  'apps',
  'app_overview',
  'app_bundles',
  'app_channels',
  'app_devices',
  'app_settings',
  'app_observe_updater',
  'app_observe_logs',
  'app_bundle_detail',
  'app_channel_detail',
  'org_settings',
  'account_settings',
]

const GLOBAL_PAGE_PATHS: Partial<Record<WebMcpConsolePage, string>> = {
  dashboard: '/dashboard',
  apps: '/apps',
  org_settings: '/settings/organization',
  account_settings: '/settings/account',
}

const APP_PAGE_SUFFIXES: Partial<Record<WebMcpConsolePage, string>> = {
  app_overview: '',
  app_bundles: '/bundles',
  app_channels: '/channels',
  app_devices: '/devices',
  app_settings: '/settings',
  app_observe_updater: '/observe/updater',
  app_observe_logs: '/observe/logs',
}

function appPathSegment(appId: string): string {
  return encodeURIComponent(appId)
}

function appBasePath(appId: string): string {
  return `/app/${appPathSegment(appId)}`
}

function requireAppId(appId: string | undefined, page: WebMcpConsolePage): string {
  if (!appId)
    throw new Error(`appId is required for ${page}`)
  return appId
}

export function buildConsoleNavigatePath(
  page: WebMcpConsolePage,
  options: {
    appId?: string
    bundleId?: number
    channelId?: number
  } = {},
): string {
  const globalPath = GLOBAL_PAGE_PATHS[page]
  if (globalPath)
    return globalPath

  const appSuffix = APP_PAGE_SUFFIXES[page]
  if (appSuffix != null)
    return `${appBasePath(requireAppId(options.appId, page))}${appSuffix}`

  if (page === 'app_bundle_detail') {
    const appId = requireAppId(options.appId, page)
    if (options.bundleId == null)
      throw new Error('appId and bundleId are required for app_bundle_detail')
    return `${appBasePath(appId)}/bundle/${options.bundleId}`
  }

  if (page === 'app_channel_detail') {
    const appId = requireAppId(options.appId, page)
    if (options.channelId == null)
      throw new Error('appId and channelId are required for app_channel_detail')
    return `${appBasePath(appId)}/channel/${options.channelId}`
  }

  throw new Error(`Unsupported console page: ${String(page)}`)
}
