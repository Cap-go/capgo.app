import type { OnboardingBuilderOptions } from '../build/onboarding/command'
import { log } from '@clack/prompts'
import { getBuilderOnlyChecklist } from '../app/builder-checklist'
import { formatCapgoCliInvokeError, getCapgoCliHttpStatus, formatError, invokeCapgoCliApi } from '../utils'

type SetupOptions = { apikey: string } & Pick<OnboardingBuilderOptions, 'apiHost' | 'analytics'>

export async function readBuilderOnlyAssignment(appId: string, options: SetupOptions, request = invokeCapgoCliApi) {
  const { data, error } = await request<{ app_id: string, onboarding?: unknown }>(`app/${encodeURIComponent(appId)}`, {
    ...options,
    method: 'GET',
    body: undefined,
    signal: AbortSignal.timeout(10_000),
  })
  if (error) {
    if (getCapgoCliHttpStatus(error) === 404)
      return null
    throw new Error(`Cannot check the app's onboarding assignment: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
  }
  return data?.app_id === appId ? getBuilderOnlyChecklist(data.onboarding) : null
}

export async function readBuilderOnlyInitAssignment(
  appId: string,
  options: SetupOptions,
  request = invokeCapgoCliApi,
  warn: (message: string) => void = log.warn,
) {
  try {
    return await readBuilderOnlyAssignment(appId, options, request)
  }
  catch (error) {
    // Assignment detection is optional: only a positive response changes init.
    // A lookup outage or inaccessible suggested app must preserve the prior flow.
    warn(`Could not check the onboarding assignment; continuing with the existing setup. ${formatError(error)}`)
    return null
  }
}

export async function tryBuilderOnlyInit(
  appId: string | undefined,
  options: SetupOptions,
  dependencies: {
    request?: typeof invokeCapgoCliApi
    warn?: (message: string) => void
    beforeLaunch?: () => Promise<void>
    launch?: (options: OnboardingBuilderOptions) => Promise<void>
    knownBuilderOnly?: boolean
  } = {},
): Promise<boolean> {
  if (!appId)
    return false
  const checklist = dependencies.knownBuilderOnly || await readBuilderOnlyInitAssignment(appId, options, dependencies.request, dependencies.warn)
  if (!checklist)
    return false
  await dependencies.beforeLaunch?.()
  const launch = dependencies.launch ?? (await import('../build/onboarding/command')).onboardingBuilderCommand
  await launch({ ...options, appId })
  return true
}

export async function resolveBuilderChecklistPlatform(
  appId: string,
  options: SetupOptions,
  explicitPlatform: string | undefined,
  inferredPlatform: OnboardingBuilderOptions['platform'],
  request = invokeCapgoCliApi,
) {
  try {
    const checklist = await readBuilderOnlyAssignment(appId, options, request)
    return { platform: explicitPlatform || checklist?.selectedPlatform || inferredPlatform, checklist }
  }
  catch {
    // A checklist lookup must not block the existing standalone Builder flow.
    return { platform: explicitPlatform || inferredPlatform, checklist: null }
  }
}
