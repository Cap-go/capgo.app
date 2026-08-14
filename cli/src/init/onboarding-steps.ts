export const INIT_ONBOARDING_STEP_IDS = [
  'add_app',
  'add_channel',
  'add_updater',
  'add_code',
  'add_encryption',
  'select_platform',
  'build_project',
  'run_device',
  'add_code_change',
  'upload_bundle',
  'test_update',
  'completion',
] as const

export type InitOnboardingStepId = typeof INIT_ONBOARDING_STEP_IDS[number]

export interface InitOnboardingStepDefinition {
  id: InitOnboardingStepId
  title: string
  summary: string
  phase: string
}

export const initOnboardingSteps: InitOnboardingStepDefinition[] = [
  {
    id: 'add_app',
    title: 'Add Your App',
    summary: 'Create the Capgo app for this project, or confirm the one you already use.',
    phase: 'Prepare',
  },
  {
    id: 'add_channel',
    title: 'Create Production Channel',
    summary: 'Set up the default release channel used for your first OTA validation.',
    phase: 'Prepare',
  },
  {
    id: 'add_updater',
    title: 'Install Updater Plugin',
    summary: 'Install the updater dependency and configure it for this project.',
    phase: 'Integrate',
  },
  {
    id: 'add_code',
    title: 'Add Integration Code',
    summary: 'Inject the app-ready hook so the native app can confirm bundle startup.',
    phase: 'Integrate',
  },
  {
    id: 'add_encryption',
    title: 'Setup Encryption',
    summary: 'Decide whether to enable end-to-end bundle encryption for sensitive apps.',
    phase: 'Integrate',
  },
  {
    id: 'select_platform',
    title: 'Select Platform',
    summary: 'Choose the device platform you want to use for the guided validation path.',
    phase: 'Integrate',
  },
  {
    id: 'build_project',
    title: 'Build Your Project',
    summary: 'Build web assets, sync native sources, and validate the generated app shell.',
    phase: 'Integrate',
  },
  {
    id: 'run_device',
    title: 'Run on Device',
    summary: 'Launch the baseline app on a real device or simulator before the OTA test.',
    phase: 'Validate',
  },
  {
    id: 'add_code_change',
    title: 'Make a Test Change',
    summary: 'Create a visible change and prepare the next version for upload.',
    phase: 'Validate',
  },
  {
    id: 'upload_bundle',
    title: 'Upload Bundle',
    summary: 'Ship the updated web bundle to Capgo for OTA delivery.',
    phase: 'Validate',
  },
  {
    id: 'test_update',
    title: 'Test Update on Device',
    summary: 'Confirm that the installed app receives and applies the OTA update.',
    phase: 'Validate',
  },
  {
    id: 'completion',
    title: 'Completion',
    summary: 'Wrap up onboarding and leave you with the next commands to use.',
    phase: 'Finish',
  },
]
