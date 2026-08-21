import type { UpdateProbeResult } from './app/updateProbe'
import { exit, stdin, stdout } from 'node:process'
import { intro, isCancel, log, select } from '@clack/prompts'
import { trackEvent } from './analytics/track'
import { explainCommonUpdateError, prepareUpdateProbe, singleProbeRequest } from './app/updateProbe'
import { getConfig } from './utils'

interface ProbeOptions {
  platform?: string
}

export interface ProbeInternalResult {
  success: boolean
  error?: string
  probeResult?: UpdateProbeResult
  endpoint?: string
  platform?: 'ios' | 'android'
  versionBuild?: string
  versionBuildSource?: string
  appId?: string
  appIdSource?: string
  nativeSource?: string
  hints?: string[]
}

export async function probeInternal(options: ProbeOptions): Promise<ProbeInternalResult> {
  let capConfig: any
  try {
    const extConfig = await getConfig()
    capConfig = extConfig.config
  }
  catch {
    // getConfig already logs the error
    return { success: false, error: 'Failed to load Capacitor config.' }
  }

  let platform: 'ios' | 'android'
  if (options.platform === 'ios' || options.platform === 'android') {
    platform = options.platform
  }
  else if (options.platform) {
    return { success: false, error: `Invalid platform "${options.platform}". Must be "ios" or "android".` }
  }
  else {
    const interactive = !!stdin.isTTY && !!stdout.isTTY
    if (!interactive) {
      return { success: false, error: 'Platform is required in non-interactive environments. Use --platform ios or --platform android.' }
    }
    const selected = await select({
      message: 'Which platform do you want to probe?',
      options: [
        { value: 'ios', label: 'iOS' },
        { value: 'android', label: 'Android' },
      ],
    })
    if (isCancel(selected)) {
      return { success: false, error: 'Probe cancelled.' }
    }
    platform = selected as 'ios' | 'android'
  }

  const prepared = await prepareUpdateProbe(platform, capConfig)
  if (!prepared.ok) {
    return { success: false, error: `Probe setup failed: ${prepared.error}` }
  }

  const ctx = prepared.context
  const result = await singleProbeRequest(ctx.endpoint, ctx.payload)

  void trackEvent({ channel: 'cli-usage', event: 'Update Probed', tags: { update_available: result.success } })

  const probeInternalResult: ProbeInternalResult = {
    success: result.success,
    probeResult: result,
    endpoint: ctx.endpoint,
    platform,
    versionBuild: ctx.payload.version_build,
    versionBuildSource: ctx.versionBuildSource,
    appId: ctx.payload.app_id,
    appIdSource: ctx.appIdSource,
    nativeSource: ctx.nativeSource,
  }

  if (!result.success) {
    probeInternalResult.hints = explainCommonUpdateError(result)
  }

  return probeInternalResult
}

export async function probe(options: ProbeOptions) {
  intro('Probe Capgo updates endpoint')

  const result = await probeInternal(options)

  if (result.error) {
    log.error(result.error)
    exit(1)
  }

  log.info(`Endpoint: ${result.endpoint}`)
  log.info(`Platform: ${result.platform}, version_build: ${result.versionBuild}`)
  log.info(`version_build source: ${result.versionBuildSource}`)
  log.info(`app_id: ${result.appId} (${result.appIdSource})`)
  log.info(`Native values source: ${result.nativeSource}`)

  const probeResult = result.probeResult!

  if (probeResult.success) {
    log.success(`Update available: ${probeResult.availableVersion}`)
  }
  else {
    log.warn(`Reason: ${probeResult.reason}`)
    if (probeResult.backendRefusal)
      log.warn('The backend actively refused the request (not a cache/propagation issue).')
    if (probeResult.errorCode)
      log.warn(`Error code: ${probeResult.errorCode}`)
    if (probeResult.backendMessage)
      log.warn(`Backend message: ${probeResult.backendMessage}`)
    if (result.hints) {
      for (const hint of result.hints)
        log.warn(`  ${hint}`)
    }
  }
}
