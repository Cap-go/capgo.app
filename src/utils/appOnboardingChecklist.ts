import type { AppOnboardingStepId } from '~/services/appOnboarding'

// Present setup goals without changing the saved v1/v2 CLI steps or their history.
const CHECKLIST_STEP_IDS: readonly AppOnboardingStepId[] = [
  'add_app',
  'login_cli_mcp',
  'add_channel',
  'add_updater',
  'add_code',
  'run_device',
  'upload_bundle',
  'test_update',
]

export function isAppOnboardingChecklistStep(id: AppOnboardingStepId) {
  return CHECKLIST_STEP_IDS.includes(id)
}
