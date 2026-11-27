import type { OnboardingCheckOptions } from './background'
import type { PreparedOnboardingCheck } from './background-check'
import { env } from 'node:process'
import { consoleHostWebForApiHost, defaultHostWeb, findSavedKeySilent, pickCapgoApiHost } from '../utils'
import { isTrustedOnboardingApiHost } from './background-api'
import { resolveNotifyAppReadyProject } from './notify-app-ready-project'
import { setupDebug } from './setup-diagnostics'

function hasCustomUpdaterEndpoint(updater: Record<string, unknown> | undefined): boolean {
  return ['updateUrl', 'statsUrl'].some((field) => {
    const value = updater?.[field]
    if (value === undefined || value === null || value === '')
      return false
    if (typeof value !== 'string')
      return true
    try {
      const hostname = new URL(value).hostname
      return !['usecapgo.com', 'capgo.app', 'capgo.com.cn'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
    }
    catch {
      return true
    }
  })
}

export async function prepareOnboardingCheck(options: OnboardingCheckOptions): Promise<Omit<PreparedOnboardingCheck, 'attemptId'> | undefined> {
  // Capture user-provided trust before evaluating executable project config.
  const trustedOrigins = env.CAPGO_TRUSTED_API_ORIGINS?.split(',') ?? []
  // CAPGO_API_HOST is the user's own host choice (China, self hosted): read it before project config runs.
  const envApiHost = env.CAPGO_API_HOST?.trim() || undefined
  const apikey = options.apikey ?? findSavedKeySilent()
  if (!apikey) {
    setupDebug('preparation skipped', { reason: 'missing_api_key' })
    return
  }
  const project = await resolveNotifyAppReadyProject(options)
  if (!project) {
    setupDebug('preparation skipped', { reason: 'project_not_resolved' })
    return
  }

  const updater = project.config.plugins?.CapacitorUpdater
  if (hasCustomUpdaterEndpoint(updater)) {
    setupDebug('preparation skipped', { reason: 'custom_updater_endpoint' })
    return
  }
  let apiHost: string
  try {
    apiHost = pickCapgoApiHost({ explicit: options.apiHost, env: envApiHost, localApi: updater?.localApi })
  }
  catch {
    setupDebug('preparation skipped', { reason: 'invalid_api_host' })
    return
  }
  if (!isTrustedOnboardingApiHost(apiHost, { apiHost: options.apiHost || envApiHost }, trustedOrigins)) {
    setupDebug('preparation skipped', { reason: 'untrusted_api_origin' })
    return
  }
  return {
    project: { dir: project.dir, workspaceRoot: project.workspaceRoot, appId: project.appId, webDir: project.webDir },
    apiHost,
    webHost: consoleHostWebForApiHost(apiHost, updater?.localWebHost || defaultHostWeb),
    apikey,
    command: options.command,
  }
}
