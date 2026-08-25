import type { CapacitorConfig } from '../config'
import type { Database } from '../types/supabase.types'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { confirm as pConfirm, isCancel as pIsCancel, log, select as pSelect, text as pText } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { addAppInternal } from '../app/add'
import { getAppListPath } from '../app/list'
import { extractApplicationIds } from '../build/onboarding/android/gradle-parser'
import { createSupabaseClient, findRoot, findSavedKeySilent, formatError, getAppId, getConfigForWrite, getOrganizationWithPermission, invokeCapgoCliApi, PACKNAME } from '../utils'
import { writeConfigUpdater } from '../config'

const APP_ID_REGEX = /^[a-z0-9]+(?:\.[\w-]+)+$/i

export function isValidAppId(appId: string) {
  return appId !== 'io.ionic.starter' && !appId.includes('--') && APP_ID_REGEX.test(appId)
}

function readAppIdFromPackageJson(packageJsonPath: string): string | undefined {
  if (!existsSync(packageJsonPath))
    return undefined
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { capacitor?: { appId?: string } }
    return packageJson.capacitor?.appId?.trim()
  }
  catch {
    return undefined
  }
}

export function parsePackageJsonOptionPaths(packageJson?: string): string[] | undefined {
  if (!packageJson?.trim())
    return undefined
  const paths = packageJson.split(',').map(path => path.trim()).filter(Boolean)
  return paths.length ? paths : undefined
}

export function collectAppIdCandidates(
  config: CapacitorConfig | undefined,
  projectRoot = findRoot(cwd()),
  packageJsonPaths?: string[],
): string[] {
  const candidates = new Set<string>()
  const push = (value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && isValidAppId(trimmed))
      candidates.add(trimmed)
  }

  push(config?.appId)
  push(config?.plugins?.CapacitorUpdater?.appId)

  const pathsToRead = packageJsonPaths?.length
    ? packageJsonPaths
    : [join(projectRoot, PACKNAME)]
  for (const packageJsonPath of pathsToRead)
    push(readAppIdFromPackageJson(packageJsonPath))

  const gradlePath = join(projectRoot, 'android', 'app', 'build.gradle')
  if (existsSync(gradlePath)) {
    try {
      const gradle = readFileSync(gradlePath, 'utf8')
      for (const applicationId of extractApplicationIds(gradle))
        push(applicationId)
    }
    catch {
      // ignore unreadable gradle file
    }
  }

  return [...candidates]
}

async function fetchCapgoApps(apikey: string, supaHost?: string, supaAnon?: string) {
  const all: Database['public']['Tables']['apps']['Row'][] = []
  let page = 0
  while (true) {
    const { data, error } = await invokeCapgoCliApi<Database['public']['Tables']['apps']['Row'][]>(
      getAppListPath(page),
      { apikey, method: 'GET', body: undefined, supaHost, supaAnon },
    )
    if (error)
      throw new Error(`Cannot list Capgo apps: ${formatError(error)}`)

    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    all.push(...batch)
    if (batch.length < 50)
      break
    page += 1
  }
  return all
}

async function persistAppIdToConfig(appId: string) {
  try {
    const extConfig = await getConfigForWrite()
    extConfig.config.appId = appId
    extConfig.config.plugins ??= {}
    extConfig.config.plugins.CapacitorUpdater = {
      ...extConfig.config.plugins.CapacitorUpdater,
      appId,
    }
    await writeConfigUpdater(extConfig, true)
  }
  catch (error) {
    log.warn(`Could not write app ID to capacitor config: ${formatError(error)}`)
    log.warn(`Set appId to ${appId} in capacitor.config manually, or pass it on the command line.`)
  }
}

export interface ResolveAppIdOptions {
  explicitAppId?: string
  config?: CapacitorConfig
  apikey?: string
  packageJsonPaths?: string[]
  interactive?: boolean
  json?: boolean
  supaHost?: string
  supaAnon?: string
}

function buildCiAppIdMessage() {
  return [
    'Missing appId.',
    'Pass it on the command line, set appId in capacitor.config, or run interactively to pick/create a Capgo app.',
    'Example: npx @capgo/cli@latest bundle upload com.example.app',
  ].join('\n')
}

function trackAppIdRecovery(
  appId: string,
  recovery: string,
  apikey?: string,
) {
  void trackEvent({
    channel: 'app',
    event: 'CLI Recovered Missing AppId',
    appId,
    apikey,
    tags: { recovery },
  })
}

// codeql[js/insecure-randomness]: explicitAppId is argv/config identity, not secret material from Math.random.
export async function resolveAppIdWithRecovery(options: ResolveAppIdOptions): Promise<string> {
  const interactive = options.interactive ?? false
  const json = options.json ?? false

  const resolved = getAppId(options.explicitAppId, options.config)
  if (resolved)
    return resolved

  const candidates = collectAppIdCandidates(options.config, findRoot(cwd()), options.packageJsonPaths)
  if (candidates.length === 1) {
    const [onlyCandidate] = candidates
    if (!interactive) {
      if (!json)
        log.info(`No appId provided. Using app ID detected from project files: ${onlyCandidate}`)
      trackAppIdRecovery(onlyCandidate, 'auto-detect', options.apikey)
      return onlyCandidate
    }
    log.info(`Detected app ID from project files: ${onlyCandidate}`)
    const useDetected = await pConfirm({ message: `Use ${onlyCandidate}?`, initialValue: true })
    if (!pIsCancel(useDetected) && useDetected) {
      await persistAppIdToConfig(onlyCandidate)
      trackAppIdRecovery(onlyCandidate, 'auto-detect', options.apikey)
      return onlyCandidate
    }
  }

  if (!interactive) {
    if (json)
      throw new Error('missing_app_id')
    throw new Error(buildCiAppIdMessage())
  }

  while (true) {
    const resolvedApikey = options.apikey || findSavedKeySilent()
    let remoteApps: Database['public']['Tables']['apps']['Row'][] = []
    if (resolvedApikey) {
      try {
        remoteApps = await fetchCapgoApps(resolvedApikey, options.supaHost, options.supaAnon)
      }
      catch (error) {
        log.warn(formatError(error))
      }
    }

    const selectOptions: { value: string, label: string }[] = []
    for (const candidate of candidates) {
      if (!selectOptions.some(option => option.value === `detected:${candidate}`)) {
        selectOptions.push({
          value: `detected:${candidate}`,
          label: `Use detected app ID: ${candidate}`,
        })
      }
    }
    for (const app of remoteApps) {
      if (!app.app_id || !isValidAppId(app.app_id))
        continue
      selectOptions.push({
        value: `remote:${app.app_id}`,
        label: `${app.name ?? app.app_id} (${app.app_id})`,
      })
    }
    selectOptions.push({ value: 'manual', label: 'Enter an app ID manually' })
    if (resolvedApikey)
      selectOptions.push({ value: 'create', label: 'Create a new app in Capgo' })

    const choice = await pSelect({
      message: 'Missing appId. How do you want to continue?',
      options: selectOptions,
    })
    if (pIsCancel(choice))
      throw new Error('Missing appId')

    if (typeof choice === 'string' && choice.startsWith('detected:')) {
      const appId = choice.slice('detected:'.length)
      await persistAppIdToConfig(appId)
      trackAppIdRecovery(appId, 'detected-select', resolvedApikey)
      return appId
    }

    if (typeof choice === 'string' && choice.startsWith('remote:')) {
      const appId = choice.slice('remote:'.length)
      await persistAppIdToConfig(appId)
      trackAppIdRecovery(appId, 'remote-select', resolvedApikey)
      return appId
    }

    if (choice === 'manual') {
      const entered = await pText({
        message: 'Enter your app ID (e.g. com.example.app):',
        validate: (value) => {
          if (!value?.trim())
            return 'App ID is required'
          if (!isValidAppId(value.trim()))
            return 'Use reverse domain notation (e.g. com.example.app)'
        },
      })
      if (pIsCancel(entered))
        continue
      const appId = (entered as string).trim()
      await persistAppIdToConfig(appId)
      trackAppIdRecovery(appId, 'manual', resolvedApikey)
      return appId
    }

    if (choice === 'create') {
      if (!resolvedApikey)
        throw new Error('Missing API key. Run `npx @capgo/cli@latest login` first.')

      const entered = await pText({
        message: 'Enter the app ID to create in Capgo (e.g. com.example.app):',
        initialValue: candidates[0],
        validate: (value) => {
          if (!value?.trim())
            return 'App ID is required'
          if (!isValidAppId(value.trim()))
            return 'Use reverse domain notation (e.g. com.example.app)'
        },
      })
      if (pIsCancel(entered))
        continue
      const appId = (entered as string).trim()
      const supabase = await createSupabaseClient(resolvedApikey, options.supaHost, options.supaAnon)
      const organization = await getOrganizationWithPermission(supabase, resolvedApikey, 'org.create_app')
      await addAppInternal(appId, { apikey: resolvedApikey, supaHost: options.supaHost, supaAnon: options.supaAnon }, organization, true)
      await persistAppIdToConfig(appId)
      log.success(`Created app ${appId} in Capgo`)
      trackAppIdRecovery(appId, 'create-app', resolvedApikey)
      return appId
    }
  }
}
