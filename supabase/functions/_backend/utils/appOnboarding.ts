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
export const APP_ONBOARDING_STEP_HISTORY_LIMIT = 10

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

interface AppOnboardingStepHistoryEntry {
  status: AppOnboardingStepStatus
  at: string
}

interface AppOnboardingStepHistoryFullEntry {
  type: 'update_history_full'
  at: string
}

type AppOnboardingStepHistory = Array<AppOnboardingStepHistoryEntry | AppOnboardingStepHistoryFullEntry>

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

function parseStepHistory(value: unknown): AppOnboardingStepHistory {
  if (!Array.isArray(value))
    return []
  const history: AppOnboardingStepHistory = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.at !== 'string')
      continue
    if (entry.type === 'update_history_full')
      history.push({ type: entry.type, at: entry.at })
    else if (STEP_STATUS_SET.has(String(entry.status)))
      history.push({ status: entry.status as AppOnboardingStepStatus, at: entry.at })
    if (history.length === APP_ONBOARDING_STEP_HISTORY_LIMIT)
      break
  }
  return history
}

function appendStepHistory(currentStep: Record<string, unknown>, nextStep: Record<string, unknown>, changedAt: string): AppOnboardingStepHistory {
  const history = parseStepHistory(currentStep.update_history)
  if (currentStep.status === nextStep.status && currentStep.at === nextStep.at)
    return history

  const lastEntry = history.at(-1)
  if (lastEntry && 'type' in lastEntry && lastEntry.type === 'update_history_full')
    return history
  if (history.length < APP_ONBOARDING_STEP_HISTORY_LIMIT)
    return [...history, { status: nextStep.status as AppOnboardingStepStatus, at: changedAt }]
  return [...history.slice(0, APP_ONBOARDING_STEP_HISTORY_LIMIT - 1), { type: 'update_history_full', at: changedAt }]
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
  const steps = parseSteps(raw.steps)
  if (Object.keys(steps).length > 0)
    patch.steps = steps

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
        at: value.at ?? existing?.at ?? now(),
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

export function appendAppOnboardingStepHistory(
  currentValue: unknown,
  mergedValue: unknown,
  patch: AppOnboardingPatch,
  now = () => new Date().toISOString(),
): Record<string, unknown> {
  const merged = isRecord(mergedValue) ? { ...mergedValue } : {}
  const mergedSetup = parseSetupRecord(merged)
  const mergedSteps = isRecord(mergedSetup.steps) ? { ...mergedSetup.steps } : {}
  const currentSteps = parseSetupRecord(currentValue).steps
  const currentStepRecords = isRecord(currentSteps) ? currentSteps : {}
  const changedAt = now()

  for (const stepId of Object.keys(patch.steps ?? {}) as AppOnboardingStepId[]) {
    const nextStep = mergedSteps[stepId]
    if (!isRecord(nextStep))
      continue

    const currentStep = isRecord(currentStepRecords[stepId]) ? currentStepRecords[stepId] : {}
    const history = appendStepHistory(currentStep, nextStep, changedAt)
    mergedSteps[stepId] = history.length > 0 ? { ...nextStep, update_history: history } : nextStep
  }

  return {
    ...merged,
    setup: {
      ...mergedSetup,
      steps: mergedSteps,
    },
  }
}
