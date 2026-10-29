/**
 * MCP server `instructions` — connect-time guidance for clients.
 * Keep under 512 chars when both onboarding variants are enabled.
 */
export function buildServerInstructions(opts: { onboardingEnabled: boolean, liveUpdateEnabled: boolean }): string {
  const base
    = 'Capgo MCP: apps, bundles, channels, Observe (capgo_observe, start at summary), '
    + 'native builds, docs (capgo_search_docs). Not signed in? capgo_login. '
    + 'Project or @capacitor/core missing? capgo_set_project_dir with the absolute app path before installing dependencies.'

  const parts = [base]
  if (opts.onboardingEnabled) {
    parts.push(' For Capgo Builder (iOS/Android signing + first cloud build), call start_capgo_builder_onboarding FIRST and follow each result `next`.')
  }
  if (opts.liveUpdateEnabled) {
    parts.push(' For Capgo live-update (OTA) setup, call start_capgo_live_update_onboarding FIRST and follow each result `next`.')
  }
  return parts.join('')
}
