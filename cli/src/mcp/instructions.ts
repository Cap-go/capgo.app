/**
 * MCP server `instructions` — connect-time guidance for clients.
 * Keep under 512 chars when both onboarding variants are enabled.
 */
export function buildServerInstructions(opts: { onboardingEnabled: boolean, liveUpdateEnabled: boolean }): string {
  const base
    = 'Capgo MCP: apps, bundles, channels, Observe (capgo_observe, summary first), '
    + 'builds, docs (capgo_search_docs), skills (capgo_list_skills, capgo_get_skill). capgo_login if needed. '
    + 'App tools accept projectDir or cwd: the absolute app path; or use capgo_set_project_dir. Check @capacitor/core. MCP Events: https://api.capgo.app/mcp/.'

  const parts = [base]
  if (opts.onboardingEnabled) {
    parts.push(' For signing and builds, call start_capgo_builder_onboarding FIRST; follow `next`.')
  }
  if (opts.liveUpdateEnabled) {
    parts.push(' For OTA setup, call start_capgo_live_update_onboarding FIRST; follow `next`.')
  }
  return parts.join('')
}
