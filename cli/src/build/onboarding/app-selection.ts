import type { CapacitorConfig } from '../../config'
import open from 'open'
import { getBuilderAppId, getConfiguredBuilderAppId } from '../app-id.js'
import { writeConfig } from '../../config/index.js'
import { consoleWebUrl, formatCapgoCliInvokeError, getCapgoCliHttpStatus, getConfigForWrite, invokeCapgoCliApi } from '../../utils.js'

export interface BuilderVisibleApp {
  app_id: string
  name: string | null
  need_onboarding?: boolean | null
}

export interface BuilderAppApiOptions {
  supaHost?: string
  supaAnon?: string
}

export type AppSelectionErrorCode = 'list' | 'read' | 'missing' | 'build' | 'permission' | 'config' | 'api'

export class AppSelectionError extends Error {
  constructor(public readonly code: AppSelectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppSelectionError'
  }
}

export function getAppSelectionSuggestion(config: CapacitorConfig): { appId: string, source: 'builder' | 'capacitor' } {
  const builderAppId = getConfiguredBuilderAppId(config)
  if (builderAppId)
    return { appId: builderAppId, source: 'builder' }
  if (typeof config.appId !== 'string' || !config.appId.trim())
    throw new AppSelectionError('config', 'Set appId in your Capacitor config before starting Builder onboarding.')
  return { appId: config.appId.trim(), source: 'capacitor' }
}

function commonDomainSegments(a: string, b: string): number {
  const left = a.toLowerCase().split('.')
  const right = b.toLowerCase().split('.')
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index])
    index++
  return index
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + Number(a[i - 1] !== b[j - 1]))
    previous = current
  }
  return previous[b.length]!
}

export function rankVisibleApps<T extends BuilderVisibleApp>(apps: T[], suggestedId: string): T[] {
  const target = suggestedId.toLowerCase()
  const scored = apps.map((app) => {
    const id = app.app_id.toLowerCase()
    return {
      app,
      prefix: commonDomainSegments(id, target),
      similarity: 1 - editDistance(id, target) / Math.max(id.length, target.length, 1),
    }
  })
  return scored.sort((a, b) => b.prefix - a.prefix || b.similarity - a.similarity || a.app.app_id.localeCompare(b.app.app_id)).map(item => item.app)
}

export async function listVisibleBuilderApps(
  apikey: string,
  options: BuilderAppApiOptions = {},
  request: typeof invokeCapgoCliApi = invokeCapgoCliApi,
): Promise<BuilderVisibleApp[]> {
  const apps: BuilderVisibleApp[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await request<BuilderVisibleApp[]>(`app?page=${page}`, {
      apikey,
      method: 'GET',
      body: undefined,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
    if (error)
      throw new AppSelectionError('list', `Could not load apps: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
    if (!Array.isArray(data))
      throw new AppSelectionError('list', 'Capgo returned an invalid app list. Please retry.')
    apps.push(...data)
    if (data.length < 50)
      return apps
  }
}

export async function verifyBuilderApp(
  apikey: string,
  appId: string,
  options: BuilderAppApiOptions = {},
  dependencies: { request?: typeof invokeCapgoCliApi } = {},
): Promise<void> {
  const request = dependencies.request ?? invokeCapgoCliApi
  const { data, error } = await request<BuilderVisibleApp>(`app/${encodeURIComponent(appId)}`, {
    apikey,
    method: 'GET',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  if (error) {
    const status = getCapgoCliHttpStatus(error)
    if (status === 401 || status === 403)
      throw new AppSelectionError('read', `This API key needs app.read permission for ${appId}.`, { cause: error })
    if (status === 404)
      throw new AppSelectionError('missing', `${appId} is no longer available. Check the app list again.`, { cause: error })
    throw new AppSelectionError('api', `Could not check app access: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
  }
  if (!data || data.app_id !== appId)
    throw new AppSelectionError('missing', `${appId} is no longer available. Check the app list again.`)

  const { data: permissionData, error: permissionError } = await request<{ allowed?: boolean }>('private/cli/check-permission', {
    apikey,
    method: 'POST',
    body: {
      apikey,
      permission_key: 'app.build_native',
      org_id: null,
      app_id: appId,
      channel_id: null,
    },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  if (permissionError)
    throw new AppSelectionError('permission', 'Could not check app.build_native permission. Please retry.', { cause: permissionError })
  if (permissionData?.allowed !== true)
    throw new AppSelectionError('build', `This API key needs app.build_native permission for ${appId}.`)
}

export async function persistBuilderAppSelection(appId: string): Promise<boolean> {
  try {
    const extConfig = await getConfigForWrite(true)
    if (getBuilderAppId(undefined, extConfig.config) === appId)
      return false
    extConfig.config.plugins ??= {}
    extConfig.config.plugins.CapgoBuilder ??= {}
    extConfig.config.plugins.CapgoBuilder.capgoBuilderAppId = appId
    await writeConfig('CapgoBuilder', extConfig)
    return true
  }
  catch (error) {
    throw new AppSelectionError('config', 'Could not save the selected Builder app ID to your Capacitor config.', { cause: error })
  }
}

export const builderAppCreationUrl = consoleWebUrl('/app/new')

export async function openBuilderAppCreation(): Promise<boolean> {
  try {
    await open(builderAppCreationUrl)
    return true
  }
  catch {
    return false
  }
}

export interface BuilderAppSelectionServices {
  list: (apikey: string) => Promise<BuilderVisibleApp[]>
  verify: (apikey: string, appId: string) => Promise<void>
  persist: (appId: string) => Promise<boolean>
  openDashboard: () => Promise<boolean>
  dashboardUrl: string
}

export function createBuilderAppSelectionServices(options: BuilderAppApiOptions = {}): BuilderAppSelectionServices {
  const dashboardAvailable = !options.supaHost && !options.supaAnon
  return {
    list: key => listVisibleBuilderApps(key, options),
    verify: (key, appId) => verifyBuilderApp(key, appId, options),
    persist: persistBuilderAppSelection,
    openDashboard: dashboardAvailable ? openBuilderAppCreation : async () => false,
    dashboardUrl: dashboardAvailable ? builderAppCreationUrl : '',
  }
}
