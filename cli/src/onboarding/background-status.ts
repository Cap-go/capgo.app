import type { PreparedOnboardingCheck } from './background-check'
import { buildCliRequestHeaders, setCurrentCliCommand } from '../analytics/cli-headers'
import { trimTrailingSlashes } from '../utils'

export interface CompletedOnboardingChecks {
  add_code: boolean
  add_updater: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export async function readCompletedOnboardingChecks({ project, apiHost, anonKey, apikey, command }: Omit<PreparedOnboardingCheck, 'attemptId'>): Promise<CompletedOnboardingChecks | undefined> {
  try {
    setCurrentCliCommand(command)
    const response = await fetch(`${trimTrailingSlashes(apiHost)}/app/${encodeURIComponent(project.appId)}`, {
      headers: buildCliRequestHeaders({
        'Authorization': apiHost.includes('/functions/v1') && anonKey ? `Bearer ${anonKey}` : apikey,
        'capgkey': apikey,
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return
    }
    const onboarding = record(record(await response.json())?.onboarding)
    if (!onboarding)
      return
    const steps = record(record(onboarding.setup)?.steps) ?? record(onboarding.steps)
    return {
      add_code: record(steps?.add_code)?.status === 'done',
      add_updater: record(steps?.add_updater)?.status === 'done',
    }
  }
  catch {
    // An unavailable or malformed status read must not suppress local checks.
  }
}
