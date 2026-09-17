import type { NotifyAppReadyCheckOptions } from './notify-app-ready-background'
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'
import { workerData } from 'node:worker_threads'
import { buildCliRequestHeaders, setCurrentCliCommand } from './analytics/cli-headers'
import { resolveNotifyAppReadyProject } from './onboarding/notify-app-ready-project'
import { scanNotifyAppReadySource } from './onboarding/notify-app-ready-source'
import { defaultApiHost, findSavedKeySilent, isCapgoManagedSupabaseHost, normalizeSupabaseHost, resolveConfiguredCapgoPublicApiHost, sendEvent, trimTrailingSlashes } from './utils'

async function check(options: NotifyAppReadyCheckOptions): Promise<void> {
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
  const anonKey = options.supaAnon ?? config.supaKey
  setCurrentCliCommand(options.command)
  const attemptId = randomUUID()
  const trackScan = async (event: 'scan_started' | 'scan_ended', timestamp: number, tags: Record<string, string | number> = {}) => {
    try {
      await sendEvent(apikey, {
        channel: 'notify-app-ready',
        event,
        tracking_version: 2,
        timestamp: new Date(timestamp),
        tags: { app_id: project.appId },
        nonPersonTags: { attempt_id: attemptId, command_path: options.command, ...tags },
      }, false, AbortSignal.timeout(500), apiHost)
    }
    catch {
      // Scan telemetry must never prevent source detection or todo reporting.
    }
  }

  await trackScan('scan_started', Date.now())
  const scanStartedAt = Date.now()
  let scanEndedAt = scanStartedAt
  let result: ReturnType<typeof scanNotifyAppReadySource> | 'error' = 'error'
  let todoReportStatus = 'not_attempted'
  let todoReportHttpStatus: number | undefined
  try {
    result = scanNotifyAppReadySource(project)
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
      body: JSON.stringify({ onboarding: { steps: { add_code: { status: 'done' } } } }),
      signal: AbortSignal.timeout(2_000),
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

void check(workerData as NotifyAppReadyCheckOptions).catch(() => {
  // Missing projects, parser/config failures, and rejected reports are optional.
}).finally(() => exit(0))
