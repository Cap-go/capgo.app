import type { OnboardingScanProject } from './notify-app-ready-project'
import { parentPort } from 'node:worker_threads'
import { buildCliRequestHeaders, setCurrentCliCommand } from '../analytics/cli-headers'
import { trimTrailingSlashes } from '../utils'
import { setupDebug, setupError } from './setup-diagnostics'

interface BackgroundOnboardingCheck {
  channel: 'notify-app-ready' | 'updater-installed'
  step: 'add_code' | 'add_updater'
  scan: (project: OnboardingScanProject) => 'found' | 'not_found' | 'unknown'
}

export interface PreparedOnboardingCheck {
  project: OnboardingScanProject
  apiHost: string
  webHost?: string
  apikey: string
  command: string
  attemptId: string
}

export async function runOnboardingCheck(prepared: PreparedOnboardingCheck, check: BackgroundOnboardingCheck): Promise<void> {
  const { project, apiHost, apikey, command } = prepared
  setCurrentCliCommand(command)

  const scanStartedAt = Date.now()
  let scanEndedAt = scanStartedAt
  let result: 'found' | 'not_found' | 'unknown' | 'error' = 'error'
  try {
    setupDebug('local scan started', { scan: check.step })
    result = check.scan(project)
    scanEndedAt = Date.now()
    setupDebug('local scan finished', { scan: check.step, result, duration_ms: scanEndedAt - scanStartedAt })
    if (result !== 'found')
      return

    const reportStarted = Date.now()
    setupDebug('step update started', { scan: check.step })
    const response = await fetch(`${trimTrailingSlashes(apiHost)}/app/${encodeURIComponent(project.appId)}`, {
      method: 'PUT',
      headers: buildCliRequestHeaders({
        'Content-Type': 'application/json',
        'Authorization': apikey,
        'capgkey': apikey,
      }),
      // Preserve source, outcome, and all unrelated onboarding steps.
      body: JSON.stringify({ onboarding: { steps: { [check.step]: { status: 'done' } } } }),
      redirect: 'manual',
    })
    setupDebug('step update finished', {
      scan: check.step,
      status: response.status,
      duration_ms: Date.now() - reportStarted,
      todo_report_status: response.ok ? 'success' : 'rejected',
      ...(response.ok ? {} : { todo_report_http_status: response.status }),
    })
    if (response.ok)
      parentPort?.postMessage({ type: 'onboarding-step', step: check.step })
    await response.body?.cancel()
  }
  catch (error) {
    setupDebug('local check failed', { scan: check.step, error: setupError(error) })
    throw error
  }
  finally {
    if (result === 'error')
      scanEndedAt = Date.now()
  }
}
