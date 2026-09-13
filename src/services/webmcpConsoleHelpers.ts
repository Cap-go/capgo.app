import type { WebMcpToolDefinition } from '~/types/webmcp'
import { WebMcpAuthError } from '~/services/webmcp'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

export const MAX_LIST_LIMIT = 100
const DEFAULT_LIST_LIMIT = 50

export const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

export const APP_ID_PROPERTY = {
  type: 'string',
  description: 'Capgo app id (bundle identifier).',
} as const

export const LIMIT_PROPERTY = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIST_LIMIT,
  description: 'Maximum number of rows to return.',
} as const

export function appIdLimitInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      appId: APP_ID_PROPERTY,
      limit: LIMIT_PROPERTY,
    },
    required: ['appId'],
    additionalProperties: false,
  }
}

export function createReadOnlyTool(
  tool: Omit<WebMcpToolDefinition, 'annotations'>,
): WebMcpToolDefinition {
  return {
    ...tool,
    annotations: { readOnlyHint: true },
  }
}

export function requireAuth(): void {
  const main = useMainStore()
  if (!main.auth)
    throw new WebMcpAuthError()
}

export async function ensureOrgReady(): Promise<void> {
  const organizationStore = useOrganizationStore()
  await organizationStore.awaitInitialLoad()
}

export async function withAuthSession<T>(handler: () => T | Promise<T>): Promise<T> {
  requireAuth()
  await ensureOrgReady()
  return handler()
}

export function requireAppAccess(appId: string): void {
  const organizationStore = useOrganizationStore()
  const org = organizationStore.getOrgByAppId(appId)
  if (!org)
    throw new Error(`App "${appId}" is not accessible in the current session`)
}

export function clampLimit(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : DEFAULT_LIST_LIMIT
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_LIST_LIMIT
  return Math.min(Math.floor(parsed), MAX_LIST_LIMIT)
}

export function parseRouteParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value))
    return value[0]
  return value
}

export function parseNumericRouteParam(value: string | string[] | undefined): number | undefined {
  const raw = parseRouteParam(value)
  if (!raw)
    return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function routeStringParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  return parseRouteParam(params[key])
}

export function routeNumericParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): number | undefined {
  return parseNumericRouteParam(params[key])
}

export function parseRequiredAppId(input: Record<string, unknown>): string {
  const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
  if (!appId)
    throw new Error('appId is required')
  return appId
}

export function parseOptionalTrimmedString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value.trim() : undefined
}

export function parseOptionalInt(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : undefined
  return Number.isFinite(parsed) ? parsed : undefined
}

export function createAppScopedReadTool(config: {
  name: string
  title: string
  description: string
  executeForApp: (appId: string, limit: number) => Promise<unknown>
}): WebMcpToolDefinition {
  return createReadOnlyTool({
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: appIdLimitInputSchema(),
    execute: async (input) => {
      return withAuthSession(async () => {
        const appId = parseRequiredAppId(input)
        requireAppAccess(appId)
        const limit = clampLimit(input.limit)
        return config.executeForApp(appId, limit)
      })
    },
  })
}
