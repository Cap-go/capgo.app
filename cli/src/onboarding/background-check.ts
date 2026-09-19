import type { OnboardingScanProject } from './notify-app-ready-project'
import { buildCliRequestHeaders, setCurrentCliCommand } from '../analytics/cli-headers'
import { sendEvent, trimTrailingSlashes } from '../utils'

interface BackgroundOnboardingCheck {
  channel: 'notify-app-ready' | 'updater-installed'
  step: 'add_code' | 'add_updater'
  scan: (project: OnboardingScanProject) => 'found' | 'not_found' | 'unknown'
}

export interface PreparedOnboardingCheck {
  project: OnboardingScanProject
  apiHost: string
  anonKey?: string
  apikey: string
  command: string
  attemptId: string
}

export async function runOnboardingCheck(prepared: PreparedOnboardingCheck, check: BackgroundOnboardingCheck): Promise<void> {
  const { project, apiHost, anonKey, apikey, command, attemptId } = prepared
  setCurrentCliCommand(command)
  const trackScan = async (event: 'scan_started' | 'scan_ended', timestamp: number, tags: Record<string, string | number> = {}) => {
    try {
      await sendEvent(apikey, {
        channel: check.channel,
        event,
        tracking_version: 2,
        timestamp: new Date(timestamp),
        tags: { app_id: project.appId },
        nonPersonTags: { attempt_id: attemptId, command_path: command, ...tags },
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
