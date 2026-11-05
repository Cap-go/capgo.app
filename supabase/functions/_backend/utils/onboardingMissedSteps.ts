export const BUILDER_STEP_IDS = {
  ios: [
    'start_setup',
    'choose_destination',
    'connect_app_store',
    'prepare_certificate',
    'prepare_profile',
    'successful_cloud_build',
  ],
  android: [
    'start_setup',
    'prepare_keystore',
    'connect_google_play',
    'successful_cloud_build',
  ],
} as const

// People (and their AI agents) rarely follow the checklist in order. A step is
// "missed" when it is still open although a later step is already done, so the
// console can focus that step as the next task. Skipping is allowed on any open
// step (with a reason), not only missed ones.
export function getMissedStepIds<T extends string>(steps: ReadonlyArray<{ id: T, status?: string | null }>): T[] {
  let lastDone = -1
  steps.forEach((step, index) => {
    if (step.status === 'done')
      lastDone = index
  })
  return steps
    .slice(0, Math.max(lastDone, 0))
    .filter(step => step.status !== 'done' && step.status !== 'skipped')
    .map(step => step.id)
}

export function isOpenOnboardingStepStatus(status?: string | null) {
  return status !== 'done' && status !== 'skipped'
}
