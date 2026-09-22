export const BUILDER_TODO_LIST_VERSION = '1'

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

export type BuilderPlatform = keyof typeof BUILDER_STEP_IDS
export type BuilderStepId = typeof BUILDER_STEP_IDS[BuilderPlatform][number]

export interface BuilderOnboardingChecklist {
  selectedPlatform: BuilderPlatform | null
  stepIds: Record<BuilderPlatform, BuilderStepId[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setupRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    return {}
  return isRecord(value.setup) ? value.setup : value
}

export function hasSupportedBuilderTodoList(value: unknown): boolean {
  const setup = setupRecord(value)
  return setup.todo_list_version === 4
    && setup.builder_todo_list_version === BUILDER_TODO_LIST_VERSION
    && Array.isArray(setup.paths)
    && setup.paths.includes('builder')
}

export function isBuilderTodoListSelected(value: unknown): boolean {
  if (!hasSupportedBuilderTodoList(value))
    return false

  const setup = setupRecord(value)
  return setup.selected_path === 'builder'
    || (Array.isArray(setup.paths) && setup.paths.length === 1 && setup.paths[0] === 'builder')
}

export function parseBuilderOnboardingChecklist(value: unknown): BuilderOnboardingChecklist {
  const setup = setupRecord(value)
  const allSteps = isRecord(setup.steps) ? setup.steps : {}
  const builderSteps = isRecord(allSteps.builder) ? allSteps.builder : {}
  const stepIds: BuilderOnboardingChecklist['stepIds'] = { ios: [], android: [] }

  for (const platform of ['ios', 'android'] as const) {
    const configuredSteps = isRecord(builderSteps[platform]) ? builderSteps[platform] : {}
    stepIds[platform] = BUILDER_STEP_IDS[platform].filter(id => isRecord(configuredSteps[id]))
  }

  const selectedPlatform = setup.selected_builder_platform
  return {
    selectedPlatform: selectedPlatform === 'ios' || selectedPlatform === 'android' ? selectedPlatform : null,
    stepIds,
  }
}
