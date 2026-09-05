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

function appPathSegment(appId: string): string {
  return encodeURIComponent(appId)
}

export function buildConsoleNavigatePath(
  page: WebMcpConsolePage,
  options: {
    appId?: string
    bundleId?: number
    channelId?: number
  } = {},
): string {
  switch (page) {
    case 'dashboard':
      return '/dashboard'
    case 'apps':
      return '/apps'
    case 'org_settings':
      return '/settings/organization'
    case 'account_settings':
      return '/settings/account'
    case 'app_overview':
      if (!options.appId)
        throw new Error('appId is required for app_overview')
      return `/app/${appPathSegment(options.appId)}`
    case 'app_bundles':
      if (!options.appId)
        throw new Error('appId is required for app_bundles')
      return `/app/${appPathSegment(options.appId)}/bundles`
    case 'app_channels':
      if (!options.appId)
        throw new Error('appId is required for app_channels')
      return `/app/${appPathSegment(options.appId)}/channels`
    case 'app_devices':
      if (!options.appId)
        throw new Error('appId is required for app_devices')
      return `/app/${appPathSegment(options.appId)}/devices`
    case 'app_settings':
      if (!options.appId)
        throw new Error('appId is required for app_settings')
      return `/app/${appPathSegment(options.appId)}/settings`
    case 'app_observe_updater':
      if (!options.appId)
        throw new Error('appId is required for app_observe_updater')
      return `/app/${appPathSegment(options.appId)}/observe/updater`
    case 'app_observe_logs':
      if (!options.appId)
        throw new Error('appId is required for app_observe_logs')
      return `/app/${appPathSegment(options.appId)}/observe/logs`
    case 'app_bundle_detail':
      if (!options.appId || options.bundleId == null)
        throw new Error('appId and bundleId are required for app_bundle_detail')
      return `/app/${appPathSegment(options.appId)}/bundle/${options.bundleId}`
    case 'app_channel_detail':
      if (!options.appId || options.channelId == null)
        throw new Error('appId and channelId are required for app_channel_detail')
      return `/app/${appPathSegment(options.appId)}/channel/${options.channelId}`
    default:
      throw new Error(`Unsupported console page: ${String(page)}`)
  }
}
