import type { AppOnboardingStepId } from '~/services/appOnboarding'

const onboardingGuide = 'https://capgo.app/docs/getting-started/onboarding/'

// Every reported step must have a relevant guide; do not fall back to the app creation page.
export const APP_ONBOARDING_STEP_GUIDES: Record<AppOnboardingStepId, string> = {
  add_app: onboardingGuide,
  login_cli_mcp: onboardingGuide,
  add_channel: `${onboardingGuide}#step-3-create-production-channel`,
  add_updater: `${onboardingGuide}#step-4-install-updater-plugin`,
  add_code: 'https://capgo.app/docs/plugins/updater/notify-app-ready/',
  add_encryption: 'https://capgo.app/docs/live-updates/encryption/#setting-up-encryption',
  select_platform: `${onboardingGuide}#step-7-select-platform`,
  build_project: `${onboardingGuide}#step-8-build-your-project`,
  run_device: `${onboardingGuide}#step-9-run-on-device`,
  add_code_change: `${onboardingGuide}#step-10-make-a-test-change`,
  upload_bundle: 'https://capgo.app/docs/getting-started/deploy/#uploading-a-bundle',
  test_update: 'https://capgo.app/docs/getting-started/deploy/#receiving-an-update-on-a-device',
  completion: `${onboardingGuide}#step-13-completion`,
}
