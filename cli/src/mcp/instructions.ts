/**
 * MCP server `instructions` — connect-time guidance for clients.
 * Keep under 512 chars when both onboarding variants are enabled.
 */
export function buildServerInstructions(opts: { onboardingEnabled: boolean, liveUpdateEnabled: boolean }): string {
  const base
    = 'Local Capgo MCP: diagnostics, uploads, signing and onboarding. '
    + 'Use https://api.capgo.app/mcp for cloud management, Observe, cloud build monitoring, docs and skills. Connect and authorize it separately. '
    + 'Local tools accept projectDir or cwd: the absolute app path; or use capgo_set_project_dir. Check @capacitor/core. capgo_login saves local credentials.'

  const parts = [base]
  if (opts.onboardingEnabled) {
    parts.push(' For signing and builds, call start_capgo_builder_onboarding FIRST; follow `next`.')
  }
  if (opts.liveUpdateEnabled) {
    parts.push(' For OTA setup, call start_capgo_live_update_onboarding FIRST; follow `next`.')
  }
  return parts.join('')
}
