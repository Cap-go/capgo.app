import type { OnboardingCheckOptions } from './background'
import type { NotifyAppReadyProject } from './notify-app-ready-project'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { buildCliRequestHeaders, setCurrentCliCommand } from '../analytics/cli-headers'
import { resolveNotifyAppReadyProject } from './notify-app-ready-project'
import { isTrustedOnboardingApiHost } from './background-api'
import { defaultApiHost, findSavedKeySilent, isCapgoManagedSupabaseHost, normalizeSupabaseHost, resolveConfiguredCapgoPublicApiHost, sendEvent, trimTrailingSlashes } from '../utils'

interface BackgroundOnboardingCheck {
  channel: 'notify-app-ready' | 'updater-installed'
  step: 'add_code' | 'add_updater'
  scan: (project: NotifyAppReadyProject) => 'found' | 'not_found' | 'unknown'
}

export async function runOnboardingCheck(options: OnboardingCheckOptions, check: BackgroundOnboardingCheck): Promise<void> {
  // Capture user-provided trust before evaluating executable project config.
  const trustedOrigins = env.CAPGO_TRUSTED_API_ORIGINS?.split(',') ?? []
  const apikey = options.apikey ?? findSavedKeySilent()
  if (!apikey)
    return
  const project = await resolveNotifyAppReadyProject(options)
  if (!project)
    return

  const updater = project.config.plugins?.CapacitorUpdater
  const config = {
    hostApi: updater?.localApi || defaultApiHost,
    supaHost: updater?.localSupa,
    supaKey: updater?.localSupaAnon,
  }
  const explicitSelfHost = options.supaHost && options.supaAnon && !isCapgoManagedSupabaseHost(options.supaHost)
  const apiHost = explicitSelfHost
    ? `${normalizeSupabaseHost(options.supaHost!)}/functions/v1`
    : resolveConfiguredCapgoPublicApiHost(config)
  if (!isTrustedOnboardingApiHost(apiHost, options, trustedOrigins))
    return
  const anonKey = options.supaAnon ?? config.supaKey
  setCurrentCliCommand(options.command)
  const attemptId = randomUUID()
  const trackScan = async (event: 'scan_started' | 'scan_ended', timestamp: number, tags: Record<string, string | number> = {}) => {
    try {
      await sendEvent(apikey, {
        channel: check.channel,
        event,
        tracking_version: 2,
        timestamp: new Date(timestamp),
        tags: { app_id: project.appId },
        nonPersonTags: { attempt_id: attemptId, command_path: options.command, ...tags },
      }, false, AbortSignal.timeout(500), apiHost, 'error')
    }
    catch {
      // Scan telemetry must never prevent onboarding detection or todo reporting.
    }
  }

  await trackScan('scan_started', Date.now())
  const scanStartedAt = Date.now()
  let scanEndedAt = scanStartedAt
  let result: 'found' | 'not_found' | 'unknown' | 'error' = 'error'
  let todoReportStatus = 'not_attempted'
  let todoReportHttpStatus: number | undefined
  try {
    result = check.scan(project)
    scanEndedAt = Date.now()
    if (result !== 'found')
      return

    todoReportStatus = 'failed'
    const response = await fetch(`${trimTrailingSlashes(apiHost)}/app/${encodeURIComponent(project.appId)}`, {
      method: 'PUT',
      headers: buildCliRequestHeaders({
        'Content-Type': 'application/json',
        'Authorization': apiHost.includes('/functions/v1') && anonKey ? `Bearer ${anonKey}` : apikey,
        'capgkey': apikey,
      }),
      // Preserve source, outcome, and all unrelated onboarding steps.
      body: JSON.stringify({ onboarding: { steps: { [check.step]: { status: 'done' } } } }),
      signal: AbortSignal.timeout(2_000),
      redirect: 'error',
    })
    todoReportHttpStatus = response.status
    todoReportStatus = response.ok ? 'success' : 'rejected'
    await response.body?.cancel()
  }
  finally {
    if (result === 'error')
      scanEndedAt = Date.now()
    await trackScan('scan_ended', scanEndedAt, {
      result,
      duration_ms: scanEndedAt - scanStartedAt,
      todo_report_status: todoReportStatus,
      ...(todoReportHttpStatus === undefined ? {} : { todo_report_http_status: todoReportHttpStatus }),
    })
  }
}
