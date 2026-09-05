import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import type { WebMcpConsoleContext, WebMcpConsolePage, WebMcpModelContext, WebMcpToolDefinition } from '~/types/webmcp'
import { useSupabase } from '~/services/supabase'
import { registerWebMcpTool, WebMcpAuthError } from '~/services/webmcp'
import { buildConsoleNavigatePath, CONSOLE_PAGES } from '~/services/webmcpConsolePaths'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const MAX_LIST_LIMIT = 100
const DEFAULT_LIST_LIMIT = 50

function clampLimit(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : DEFAULT_LIST_LIMIT
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_LIST_LIMIT
  return Math.min(Math.floor(parsed), MAX_LIST_LIMIT)
}

function parseRouteParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value))
    return value[0]
  return value
}

function parseNumericRouteParam(value: string | string[] | undefined): number | undefined {
  const raw = parseRouteParam(value)
  if (!raw)
    return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function buildConsoleContext(route: RouteLocationNormalizedLoaded): WebMcpConsoleContext {
  const main = useMainStore()
  const organizationStore = useOrganizationStore()
  const appDetailStore = useAppDetailStore()

  const routeAppId = parseRouteParam(route.params.app)
  const routeChannelId = parseNumericRouteParam(route.params.channel)
  const routeBundleId = parseNumericRouteParam(route.params.bundle)
  const routeDeviceId = parseRouteParam(route.params.device)

  const orgFromApp = routeAppId ? organizationStore.getOrgByAppId(routeAppId) : undefined
  const appFromOrg = routeAppId ? organizationStore.getAppByAppId(routeAppId) : undefined
  const currentOrg = orgFromApp ?? organizationStore.currentOrganization

  const context: WebMcpConsoleContext = {
    authenticated: !!main.auth,
    path: route.path,
    fullPath: route.fullPath,
  }

  if (main.auth?.id)
    context.userId = main.auth.id
  if (main.auth?.email)
    context.email = main.auth.email
  if (main.isAdmin)
    context.isPlatformAdmin = true

  if (currentOrg) {
    context.organization = {
      id: currentOrg.gid,
      name: currentOrg.name,
      role: currentOrg.role ?? organizationStore.currentRole,
    }
  }

  const appId = routeAppId ?? appDetailStore.currentAppId
  if (appId) {
    context.app = {
      id: appId,
      name: appDetailStore.currentApp?.name ?? appFromOrg?.name ?? null,
    }
  }

  const channelId = routeChannelId ?? appDetailStore.currentChannelId ?? undefined
  if (channelId != null) {
    context.channel = {
      id: channelId,
      name: appDetailStore.currentChannel?.name ?? null,
    }
  }

  const bundleId = routeBundleId ?? appDetailStore.currentBundleId ?? undefined
  if (bundleId != null) {
    context.bundle = {
      id: bundleId,
      name: appDetailStore.currentBundle?.name ?? null,
    }
  }

  if (routeDeviceId || appDetailStore.currentDeviceId) {
    context.device = {
      id: routeDeviceId ?? appDetailStore.currentDeviceId,
    }
  }

  return context
}

function requireAuth(): void {
  const main = useMainStore()
  if (!main.auth)
    throw new WebMcpAuthError()
}

async function ensureOrgReady(): Promise<void> {
  const organizationStore = useOrganizationStore()
  await organizationStore.awaitInitialLoad()
}

function requireAppAccess(appId: string): void {
  const organizationStore = useOrganizationStore()
  const org = organizationStore.getOrgByAppId(appId)
  if (!org)
    throw new Error(`App "${appId}" is not accessible in the current session`)
}

function createGetContextTool(route: RouteLocationNormalizedLoaded): WebMcpToolDefinition {
  return {
    name: 'console_get_context',
    title: 'Get console context',
    description: 'Returns the current Capgo console route, authentication state, organization, and active app/channel/bundle context.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: () => buildConsoleContext(route),
  }
}

function createListOrganizationsTool(): WebMcpToolDefinition {
  return {
    name: 'console_list_organizations',
    title: 'List organizations',
    description: 'Lists organizations the signed-in user can access in the Capgo console.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async () => {
      requireAuth()
      await ensureOrgReady()
      const organizationStore = useOrganizationStore()
      return {
        organizations: organizationStore.organizations.map(org => ({
          id: org.gid,
          name: org.name,
          role: org.role,
        })),
      }
    },
  }
}

function createListAppsTool(): WebMcpToolDefinition {
  return {
    name: 'console_list_apps',
    title: 'List apps',
    description: 'Lists apps for the current organization or a specified organization id.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: {
          type: 'string',
          description: 'Optional organization id. Defaults to the current organization.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      requireAuth()
      await ensureOrgReady()
      const organizationStore = useOrganizationStore()
      const orgId = typeof input.orgId === 'string' && input.orgId.length > 0
        ? input.orgId
        : organizationStore.currentOrganization?.gid

      if (!orgId)
        throw new Error('No organization selected')

      const org = organizationStore.organizations.find(item => item.gid === orgId)
      if (!org)
        throw new Error(`Organization "${orgId}" is not accessible in the current session`)

      if (organizationStore.currentOrganization?.gid !== orgId)
        organizationStore.setCurrentOrganization(orgId)

      const dashboardAppsStore = useDashboardAppsStore()
      await dashboardAppsStore.fetchApps(true)

      return {
        orgId,
        apps: dashboardAppsStore.apps.map(app => ({
          appId: app.app_id,
          name: app.name,
        })),
      }
    },
  }
}

function createListChannelsTool(): WebMcpToolDefinition {
  return {
    name: 'console_list_channels',
    title: 'List channels',
    description: 'Lists update channels for a Capgo app.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'Capgo app id (bundle identifier).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: 'Maximum number of channels to return.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      requireAuth()
      await ensureOrgReady()
      const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
      if (!appId)
        throw new Error('appId is required')
      requireAppAccess(appId)

      const limit = clampLimit(input.limit)
      const supabase = useSupabase()
      const { data, error } = await supabase
        .from('channels')
        .select(`
          id,
          name,
          app_id,
          public,
          version:app_versions!channels_version_fkey(
            id,
            name
          )
        `)
        .eq('app_id', appId)
        .order('name', { ascending: true })
        .limit(limit)

      if (error)
        throw new Error(error.message)

      return {
        appId,
        channels: (data ?? []).map(channel => ({
          id: channel.id,
          name: channel.name,
          public: channel.public,
          version: channel.version
            ? {
                id: channel.version.id,
                name: channel.version.name,
              }
            : null,
        })),
      }
    },
  }
}

function createListBundlesTool(): WebMcpToolDefinition {
  return {
    name: 'console_list_bundles',
    title: 'List bundles',
    description: 'Lists uploaded bundles (app versions) for a Capgo app.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'Capgo app id (bundle identifier).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: 'Maximum number of bundles to return.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      requireAuth()
      await ensureOrgReady()
      const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
      if (!appId)
        throw new Error('appId is required')
      requireAppAccess(appId)

      const limit = clampLimit(input.limit)
      const supabase = useSupabase()
      const { data, error } = await supabase
        .from('app_versions')
        .select('id, name, created_at, deleted, storage_provider')
        .eq('app_id', appId)
        .eq('deleted', false)
        .neq('storage_provider', 'revert_to_builtin')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error)
        throw new Error(error.message)

      return {
        appId,
        bundles: (data ?? []).map(bundle => ({
          id: bundle.id,
          name: bundle.name,
          createdAt: bundle.created_at,
        })),
      }
    },
  }
}

function createNavigateTool(router: Router): WebMcpToolDefinition {
  return {
    name: 'console_navigate',
    title: 'Navigate console',
    description: 'Navigates the Capgo console SPA to a supported page such as apps, dashboard, bundles, or channels.',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: CONSOLE_PAGES,
          description: 'Target console page.',
        },
        appId: {
          type: 'string',
          description: 'Required for app-scoped pages.',
        },
        bundleId: {
          type: 'integer',
          description: 'Required for app_bundle_detail.',
        },
        channelId: {
          type: 'integer',
          description: 'Required for app_channel_detail.',
        },
      },
      required: ['page'],
      additionalProperties: false,
    },
    execute: async (input) => {
      requireAuth()
      await ensureOrgReady()

      const page = input.page as WebMcpConsolePage
      if (!CONSOLE_PAGES.includes(page))
        throw new Error(`Unsupported page "${String(input.page)}"`)

      const appId = typeof input.appId === 'string' ? input.appId.trim() : undefined
      if (appId)
        requireAppAccess(appId)

      const bundleId = typeof input.bundleId === 'number'
        ? input.bundleId
        : typeof input.bundleId === 'string'
          ? Number.parseInt(input.bundleId, 10)
          : undefined
      const channelId = typeof input.channelId === 'number'
        ? input.channelId
        : typeof input.channelId === 'string'
          ? Number.parseInt(input.channelId, 10)
          : undefined

      const path = buildConsoleNavigatePath(page, {
        appId,
        bundleId: Number.isFinite(bundleId) ? bundleId : undefined,
        channelId: Number.isFinite(channelId) ? channelId : undefined,
      })

      await router.push(path)

      return {
        navigated: true,
        path,
      }
    },
  }
}

export function createConsoleWebMcpTools(options: {
  route: RouteLocationNormalizedLoaded
  router: Router
  authenticated: boolean
}): WebMcpToolDefinition[] {
  const tools: WebMcpToolDefinition[] = [createGetContextTool(options.route)]

  if (!options.authenticated)
    return tools

  tools.push(
    createListOrganizationsTool(),
    createListAppsTool(),
    createListChannelsTool(),
    createListBundlesTool(),
    createNavigateTool(options.router),
  )

  return tools
}

export async function registerConsoleWebMcpTools(
  modelContext: WebMcpModelContext,
  options: {
    route: RouteLocationNormalizedLoaded
    router: Router
    authenticated: boolean
    signal: AbortSignal
  },
): Promise<void> {
  const tools = createConsoleWebMcpTools(options)
  await Promise.all(
    tools.map(tool => registerWebMcpTool(modelContext, tool, { signal: options.signal })),
  )
}
