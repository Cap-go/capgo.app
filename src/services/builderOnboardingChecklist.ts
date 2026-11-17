import { BUILDER_STEP_IDS } from '../../supabase/functions/_backend/utils/onboardingMissedSteps.ts'

export { BUILDER_STEP_IDS } from '../../supabase/functions/_backend/utils/onboardingMissedSteps.ts'

export const BUILDER_TODO_LIST_VERSION = '1'

export type BuilderPlatform = keyof typeof BUILDER_STEP_IDS
export type BuilderStepId = typeof BUILDER_STEP_IDS[BuilderPlatform][number]
/** How the user runs Builder setup: through their AI assistant (MCP) or the CLI wizard. */
export type BuilderSetupMethod = 'ai' | 'terminal'
export type BuilderStepStatus = 'pending' | 'done' | 'skipped' | 'warning'

export interface BuilderOnboardingState {
  selectedPlatform: BuilderPlatform | null
  steps: Record<BuilderPlatform, Partial<Record<BuilderStepId, BuilderStepStatus>>>
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

export function parseBuilderOnboarding(value: unknown): BuilderOnboardingState {
  const setup = setupRecord(value)
  const rawSteps = isRecord(setup.steps) && isRecord(setup.steps.builder) ? setup.steps.builder : {}
  const steps: BuilderOnboardingState['steps'] = { ios: {}, android: {} }

  for (const platform of ['ios', 'android'] as const) {
    const platformSteps = isRecord(rawSteps[platform]) ? rawSteps[platform] : {}
    for (const id of BUILDER_STEP_IDS[platform]) {
      const step = platformSteps[id]
      if (isRecord(step) && (step.status === 'pending' || step.status === 'done' || step.status === 'skipped' || step.status === 'warning'))
        steps[platform][id] = step.status
    }
  }

  const selectedPlatform = setup.selected_builder_platform
  return {
    selectedPlatform: selectedPlatform === 'ios' || selectedPlatform === 'android' ? selectedPlatform : null,
    steps,
  }
}

/** Platforms the CLI or the AI assistant has started: any step left `pending`. */
export function startedBuilderPlatforms(state: BuilderOnboardingState): BuilderPlatform[] {
  return (['ios', 'android'] as const).filter(platform => Object.values(state.steps[platform]).some(status => status && status !== 'pending'))
}

/** Hides the API key at the end of the Builder setup command until the user reveals it. */
export function maskBuilderCommand(command: string): string {
  return command.replace(/(-a )(\S{3})\S+(\S{4})$/, '$1$2••••••••$3')
}
