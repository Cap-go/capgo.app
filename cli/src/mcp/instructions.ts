/**
 * MCP server `instructions` — connect-time guidance for clients.
 * Keep under 512 chars when both onboarding variants are enabled.
 */
export function buildServerInstructions(opts: { onboardingEnabled: boolean, liveUpdateEnabled: boolean }): string {
  const base
    = 'Capgo MCP: apps, bundles, channels, Observe (capgo_observe, summary first), '
    + 'native builds, docs (capgo_search_docs). MCP Events: https://api.capgo.app/mcp/. capgo_login if needed. '
    + 'All tools accept projectDir or cwd: the absolute app path; or use capgo_set_project_dir. Check @capacitor/core.'

  const parts = [base]
  if (opts.onboardingEnabled) {
    parts.push(' For Capgo Builder (iOS/Android signing + first build), call start_capgo_builder_onboarding FIRST; follow `next`.')
  }
  if (opts.liveUpdateEnabled) {
    parts.push(' For live-update (OTA) setup, call start_capgo_live_update_onboarding FIRST; follow `next`.')
  }
  return parts.join('')
}
