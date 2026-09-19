/**
 * MCP server `instructions` — connect-time guidance for clients.
 * Keep under 512 chars when both onboarding variants are enabled.
 */
export function buildServerInstructions(opts: { onboardingEnabled: boolean, liveUpdateEnabled: boolean }): string {
  const base
    = 'Capgo Cloud MCP server: manage Capgo apps and live updates — list apps, '
    + 'upload and clean up bundles, set channels, query Observe (capgo_observe, start at summary), '
    + 'and request native cloud builds. Tools use the saved Capgo API key; not signed in? Call capgo_login.'

  const parts = [base]
  if (opts.onboardingEnabled) {
    parts.push(' For Capgo Builder (iOS/Android signing + first cloud build), call start_capgo_builder_onboarding FIRST and follow each result `next`.')
  }
  if (opts.liveUpdateEnabled) {
    parts.push(' For Capgo live-update (OTA) setup, call start_capgo_live_update_onboarding FIRST and follow each result `next`.')
  }
  return parts.join('')
}
