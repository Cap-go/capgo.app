export const APP_ONBOARDING_STEP_IDS = [
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

export type AppOnboardingStepId = typeof APP_ONBOARDING_STEP_IDS[number]
export type AppOnboardingSource = 'manual' | 'cli' | 'mcp' | 'ai'
export type AppOnboardingOutcome = 'in_progress' | 'completed' | 'skipped' | 'switched_to_manual'
export type AppOnboardingStepStatus = 'done' | 'skipped'

export interface AppOnboardingStepState {
  status: AppOnboardingStepStatus
  at?: string
}

export interface AppOnboardingState {
  source: AppOnboardingSource
  outcome: AppOnboardingOutcome
  steps: Partial<Record<AppOnboardingStepId, AppOnboardingStepState>>
  updated_at?: string
}

export interface AppOnboardingPatch {
  source?: AppOnboardingSource
  outcome?: AppOnboardingOutcome
  steps?: Partial<Record<AppOnboardingStepId, AppOnboardingStepState>>
}

const SOURCE_RANK: Record<AppOnboardingSource, number> = {
  manual: 0,
  ai: 1,
  cli: 2,
  mcp: 3,
}

const STEP_ID_SET = new Set<string>(APP_ONBOARDING_STEP_IDS)
const SOURCE_SET = new Set<string>(['manual', 'cli', 'mcp', 'ai'])
const OUTCOME_SET = new Set<string>(['in_progress', 'completed', 'skipped', 'switched_to_manual'])
const STEP_STATUS_SET = new Set<string>(['done', 'skipped'])

export function defaultAppOnboarding(): AppOnboardingState {
  return {
    source: 'manual',
    outcome: 'in_progress',
    steps: {},
  }
}

export function isAppOnboardingSource(value: unknown): value is AppOnboardingSource {
  return typeof value === 'string' && SOURCE_SET.has(value)
}

export function isAppOnboardingOutcome(value: unknown): value is AppOnboardingOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value)
}

export function isAppOnboardingStepId(value: unknown): value is AppOnboardingStepId {
  return typeof value === 'string' && STEP_ID_SET.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSetupRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    return {}
  return isRecord(value.setup) ? value.setup : value
}

function parseSteps(value: unknown): AppOnboardingState['steps'] {
  const steps: AppOnboardingState['steps'] = {}
  if (!isRecord(value))
    return steps
  for (const [key, stepValue] of Object.entries(value)) {
    if (!isAppOnboardingStepId(key) || !isRecord(stepValue))
      continue
    const status = stepValue.status
    if (!STEP_STATUS_SET.has(String(status)))
      continue
    const at = stepValue.at
    steps[key] = {
      status: status as AppOnboardingStepStatus,
      ...(typeof at === 'string' ? { at } : {}),
    }
  }
  return steps
}

export function parseAppOnboarding(value: unknown): AppOnboardingState {
  const fallback = defaultAppOnboarding()
  const raw = parseSetupRecord(value)
  const source = isAppOnboardingSource(raw.source) ? raw.source : fallback.source
  const outcome = isAppOnboardingOutcome(raw.outcome) ? raw.outcome : fallback.outcome
  const steps = parseSteps(raw.steps)

  return {
    source,
    outcome,
    steps,
    ...(typeof raw.updated_at === 'string' ? { updated_at: raw.updated_at } : {}),
  }
}

export function parseAppOnboardingPatch(value: unknown): AppOnboardingPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null

  const raw = value as Record<string, unknown>
  const patch: AppOnboardingPatch = {}
  if (isAppOnboardingSource(raw.source))
    patch.source = raw.source
  if (isAppOnboardingOutcome(raw.outcome))
    patch.outcome = raw.outcome
  if (raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps)) {
    const steps: NonNullable<AppOnboardingPatch['steps']> = {}
    for (const [key, stepValue] of Object.entries(raw.steps as Record<string, unknown>)) {
      if (!isAppOnboardingStepId(key) || !stepValue || typeof stepValue !== 'object' || Array.isArray(stepValue))
        continue
      const status = (stepValue as { status?: unknown }).status
      if (!STEP_STATUS_SET.has(String(status)))
        continue
      const at = (stepValue as { at?: unknown }).at
      steps[key] = {
        status: status as AppOnboardingStepStatus,
        ...(typeof at === 'string' ? { at } : {}),
      }
    }
    if (Object.keys(steps).length > 0)
      patch.steps = steps
  }

  if (!patch.source && !patch.outcome && !patch.steps)
    return null

  return patch
}

export function pickAppOnboardingSource(
  current: AppOnboardingSource,
  next?: AppOnboardingSource,
): AppOnboardingSource {
  if (!next)
    return current
  return SOURCE_RANK[next] >= SOURCE_RANK[current] ? next : current
}

export function deriveAppOnboardingOutcome(
  steps: AppOnboardingState['steps'],
  current: AppOnboardingOutcome,
  patch?: AppOnboardingOutcome,
): AppOnboardingOutcome {
  const statuses = APP_ONBOARDING_STEP_IDS.map(id => steps[id]?.status)
  const allPresent = statuses.every(status => status === 'done' || status === 'skipped')
  const anySkipped = statuses.includes('skipped')

  if (allPresent)
    return anySkipped ? 'skipped' : 'completed'

  if (patch === 'completed' || patch === 'skipped')
    return patch

  if (patch === 'switched_to_manual' || current === 'switched_to_manual')
    return 'switched_to_manual'

  return 'in_progress'
}

export function mergeAppOnboarding(
  currentValue: unknown,
  patch: AppOnboardingPatch,
  now = () => new Date().toISOString(),
): AppOnboardingState {
  const current = parseAppOnboarding(currentValue)
  const steps: AppOnboardingState['steps'] = { ...current.steps }

  if (patch.steps) {
    for (const [key, value] of Object.entries(patch.steps) as Array<[AppOnboardingStepId, AppOnboardingStepState | undefined]>) {
      if (!value)
        continue
      const existing = steps[key]
      if (existing?.status === 'done' && value.status === 'skipped')
        continue
      steps[key] = {
        status: value.status,
        at: value.at ?? now(),
      }
    }
  }

  return {
    source: pickAppOnboardingSource(current.source, patch.source),
    outcome: deriveAppOnboardingOutcome(steps, current.outcome, patch.outcome),
    steps,
    updated_at: now(),
  }
}

export function applyAppOnboardingPatch(
  currentValue: unknown,
  patch: AppOnboardingPatch,
  now = () => new Date().toISOString(),
): Record<string, unknown> {
  const existing = isRecord(currentValue) ? { ...currentValue } : {}
  const setup = mergeAppOnboarding(existing.setup ?? existing, patch, now)
  delete existing.source
  delete existing.outcome
  delete existing.steps
  delete existing.updated_at
  return {
    ...existing,
    setup,
  }
}
