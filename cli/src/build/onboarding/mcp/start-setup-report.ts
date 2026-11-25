// src/build/onboarding/mcp/start-setup-report.ts
import type { TrackBuilderOnboardingActionInput } from '../telemetry.js'
import type { NextStepResult, Platform } from './contract.js'
import { randomUUID } from 'node:crypto'

export interface StartSetupReportDeps {
  getApiKey: () => string | undefined
  getAppId: () => Promise<string | undefined>
  resolveOrgId: (apikey: string, appId: string) => Promise<string | undefined>
  track: (input: TrackBuilderOnboardingActionInput) => Promise<void>
}

// Results from these phases mean the agent is setting up one platform of a known app.
const PLATFORM_PHASES = new Set<NextStepResult['phase']>(['credentials', 'build', 'done'])

/**
 * The console's Builder checklist only learns which platform the user is setting up from the
 * `start_setup` action (the TUI sends it once the platform is known). The MCP flow sends the same
 * action, once per app and platform, so the dashboard can follow along.
 */
export function createStartSetupReporter(deps: StartSetupReportDeps) {
  const reported = new Set<string>()
  const journeyId = `mcp_${randomUUID()}`

  return async function reportStartSetup(result: NextStepResult): Promise<void> {
    const platform: Platform | undefined = result.platform
    if (!platform || !PLATFORM_PHASES.has(result.phase))
      return
    try {
      const apikey = deps.getApiKey()
      const appId = apikey ? await deps.getAppId() : undefined
      if (!apikey || !appId)
        return
      const key = `${appId}:${platform}`
      if (reported.has(key))
        return
      reported.add(key)
      const orgId = await deps.resolveOrgId(apikey, appId)
      if (!orgId) {
        reported.delete(key)
        return
      }
      await deps.track({
        action: 'start_setup',
        apikey,
        appId,
        journeyId,
        orgId,
        platform,
        step: result.state as TrackBuilderOnboardingActionInput['step'],
        tags: { source: 'mcp' },
      })
    }
    catch {
      // Telemetry must never break onboarding.
    }
  }
}
