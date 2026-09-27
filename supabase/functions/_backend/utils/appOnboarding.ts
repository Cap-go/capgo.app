export const APP_ONBOARDING_V1_STEP_IDS = [
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

export const APP_ONBOARDING_V2_STEP_IDS = [
  'login_cli_mcp',
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

export const APP_ONBOARDING_OTA_V1_VERSION = '1'
export const APP_ONBOARDING_OTA_V1_STEP_IDS = [
  'login_cli_mcp',
  'add_channel',
  'add_updater',
  'add_code',
  'run_device',
  'upload_bundle',
  'test_update',
] as const

export const APP_ONBOARDING_V3_STEP_IDS = [...APP_ONBOARDING_OTA_V1_STEP_IDS] as const

export type AppOnboardingStepId
  = | typeof APP_ONBOARDING_V1_STEP_IDS[number]
    | typeof APP_ONBOARDING_V2_STEP_IDS[number]
export type AppOnboardingSource = 'manual' | 'cli' | 'mcp' | 'ai'
export type AppOnboardingOutcome = 'in_progress' | 'completed' | 'skipped' | 'switched_to_manual'
export type AppOnboardingStepStatus = 'pending' | 'done' | 'skipped'
export type AppOnboardingBuilderStepStatus = AppOnboardingStepStatus | 'warning'
export type AppOnboardingBuilderStepId = `builder.${'ios' | 'android'}.${string}`
export const APP_ONBOARDING_STEP_HISTORY_LIMIT = 10
export const DEFAULT_APP_ONBOARDING_TODO_LIST_VERSION = 2

export interface AppOnboardingStepState {
  status: AppOnboardingStepStatus
  at?: string
}

export interface AppOnboardingBuilderStepState {
  status: AppOnboardingBuilderStepStatus
  at?: string
  annotation?: string
  annotationType?: 'note' | 'warning'
}

export interface AppOnboardingState {
  todo_list_version: number
  ota_todo_list_version?: string
  source: AppOnboardingSource
  outcome: AppOnboardingOutcome
  steps: Partial<Record<AppOnboardingStepId, AppOnboardingStepState>>
  updated_at?: string
}

export interface AppOnboardingPatch {
  source?: AppOnboardingSource
  outcome?: AppOnboardingOutcome
  steps?: Partial<Record<AppOnboardingStepId, AppOnboardingStepState>>
  /** Trusted server-only nested Builder updates. Public patch parsing ignores this field. */
  builderSteps?: Partial<Record<AppOnboardingBuilderStepId, AppOnboardingBuilderStepState>>
}

interface AppOnboardingStepHistoryEntry {
  status: Exclude<AppOnboardingBuilderStepStatus, 'pending'>
  at: string
}

interface AppOnboardingStepHistoryFullEntry {
  type: 'update_history_full'
  at: string
}

type AppOnboardingStepHistory = Array<AppOnboardingStepHistoryEntry | AppOnboardingStepHistoryFullEntry>

export interface AppOnboardingStepHistoryChange {
  stepId: AppOnboardingStepId | AppOnboardingBuilderStepId
  status: Exclude<AppOnboardingBuilderStepStatus, 'pending'>
  at: string
  historyLength: number
  historyFull: boolean
}

const SOURCE_RANK: Record<AppOnboardingSource, number> = {
  manual: 0,
  ai: 1,
  cli: 2,
  mcp: 3,
}

const STEP_ID_SET = new Set<string>([...APP_ONBOARDING_V1_STEP_IDS, ...APP_ONBOARDING_V2_STEP_IDS])
const SOURCE_SET = new Set<string>(['manual', 'cli', 'mcp', 'ai'])
const OUTCOME_SET = new Set<string>(['in_progress', 'completed', 'skipped', 'switched_to_manual'])
const STEP_STATUS_SET = new Set<string>(['done', 'skipped'])
const HISTORY_STEP_STATUS_SET = new Set<string>(['done', 'skipped', 'warning'])

export function defaultAppOnboarding(): AppOnboardingState {
  return {
    todo_list_version: DEFAULT_APP_ONBOARDING_TODO_LIST_VERSION,
    source: 'manual',
    outcome: 'in_progress',
    steps: {},
  }
}

export function getAppOnboardingStepIds(todoListVersion: number, otaTodoListVersion?: string): readonly AppOnboardingStepId[] {
  // TODO(2027-03-19): Remove v3 flat-step support after existing rows migrate.
  if (todoListVersion === 3)
    return APP_ONBOARDING_V3_STEP_IDS
  if (todoListVersion === 4)
    return otaTodoListVersion === APP_ONBOARDING_OTA_V1_VERSION ? APP_ONBOARDING_OTA_V1_STEP_IDS : []
  if (todoListVersion === 1)
    return APP_ONBOARDING_V1_STEP_IDS
  return APP_ONBOARDING_V2_STEP_IDS
}

export function hasSupportedOtaTodoList(onboarding: Pick<AppOnboardingState, 'todo_list_version' | 'ota_todo_list_version'>): boolean {
  return onboarding.todo_list_version === 3
    || (onboarding.todo_list_version === 4 && onboarding.ota_todo_list_version === APP_ONBOARDING_OTA_V1_VERSION)
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

function parseTodoListVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_APP_ONBOARDING_TODO_LIST_VERSION
}

function parseSteps(value: unknown, includePending = false): AppOnboardingState['steps'] {
  const steps: AppOnboardingState['steps'] = {}
  if (!isRecord(value))
    return steps
  for (const [key, stepValue] of Object.entries(value)) {
    if (!isAppOnboardingStepId(key) || !isRecord(stepValue))
      continue
    const status = stepValue.status
    if (!STEP_STATUS_SET.has(String(status)) && !(includePending && status === 'pending'))
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
    else if (HISTORY_STEP_STATUS_SET.has(String(entry.status)))
      history.push({ status: entry.status as Exclude<AppOnboardingBuilderStepStatus, 'pending'>, at: entry.at })
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
    return [...history, { status: nextStep.status as Exclude<AppOnboardingBuilderStepStatus, 'pending'>, at: changedAt }]
  return [...history.slice(0, APP_ONBOARDING_STEP_HISTORY_LIMIT - 1), { type: 'update_history_full', at: changedAt }]
}

export function parseAppOnboarding(value: unknown): AppOnboardingState {
  const fallback = defaultAppOnboarding()
  const raw = parseSetupRecord(value)
  const source = isAppOnboardingSource(raw.source) ? raw.source : fallback.source
  const outcome = isAppOnboardingOutcome(raw.outcome) ? raw.outcome : fallback.outcome
  const todoListVersion = parseTodoListVersion(raw.todo_list_version)
  const otaTodoListVersion = typeof raw.ota_todo_list_version === 'string' ? raw.ota_todo_list_version : undefined
  const isOtaV1 = todoListVersion === 4 && otaTodoListVersion === APP_ONBOARDING_OTA_V1_VERSION
  const rawSteps = isRecord(raw.steps) ? raw.steps : {}
  const steps = isOtaV1
    ? parseSteps(rawSteps.ota, true)
    : todoListVersion === 4 ? {} : parseSteps(rawSteps)
  if (isOtaV1) {
    for (const id of Object.keys(steps) as AppOnboardingStepId[]) {
      if (!(APP_ONBOARDING_OTA_V1_STEP_IDS as readonly string[]).includes(id))
        delete steps[id]
    }
    for (const id of APP_ONBOARDING_OTA_V1_STEP_IDS)
      steps[id] ??= { status: 'pending' }
  }

  return {
    todo_list_version: todoListVersion,
    ...(todoListVersion === 4 && otaTodoListVersion !== undefined ? { ota_todo_list_version: otaTodoListVersion } : {}),
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
  const rawSteps = isRecord(raw.steps) ? raw.steps : {}
  const steps = parseSteps(isRecord(rawSteps.ota) ? rawSteps.ota : rawSteps)
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
  todoListVersion = DEFAULT_APP_ONBOARDING_TODO_LIST_VERSION,
  otaTodoListVersion?: string,
): AppOnboardingOutcome {
  const statuses = getAppOnboardingStepIds(todoListVersion, otaTodoListVersion).map(id => steps[id]?.status)
  if (todoListVersion === 4 && statuses.length === 0)
    return patch === 'skipped' || patch === 'switched_to_manual' ? patch : current
  const allPresent = statuses.every(status => status === 'done' || status === 'skipped')
  const anySkipped = statuses.includes('skipped')

  if (allPresent)
    return anySkipped ? 'skipped' : 'completed'

  if ((patch === 'completed' && todoListVersion !== 3 && todoListVersion !== 4) || patch === 'skipped')
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
  const stepIds = new Set(getAppOnboardingStepIds(current.todo_list_version, current.ota_todo_list_version))

  if (patch.steps) {
    for (const [key, value] of Object.entries(patch.steps) as Array<[AppOnboardingStepId, AppOnboardingStepState | undefined]>) {
      if (!value || (!STEP_STATUS_SET.has(value.status) && value.status !== 'pending'))
        continue
      if (!stepIds.has(key))
        continue
      // Only trusted patches reach this reset; public parsing rejects pending.
      if (value.status === 'pending') {
        if (current.todo_list_version === 4)
          steps[key] = { status: 'pending' }
        else
          delete steps[key]
        continue
      }
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
    todo_list_version: current.todo_list_version,
    ...(current.ota_todo_list_version !== undefined ? { ota_todo_list_version: current.ota_todo_list_version } : {}),
    source: pickAppOnboardingSource(current.source, patch.source),
    outcome: deriveAppOnboardingOutcome(steps, current.outcome, patch.outcome, current.todo_list_version, current.ota_todo_list_version),
    steps,
    updated_at: now(),
  }
}

function parseBuilderStepId(stepId: string): { platform: 'ios' | 'android', step: string } | null {
  const match = /^builder\.(ios|android)\.([a-z0-9_]+)$/.exec(stepId)
  return match ? { platform: match[1] as 'ios' | 'android', step: match[2]! } : null
}

function getBuilderStepRecord(value: unknown, stepId: string): Record<string, unknown> | null {
  const path = parseBuilderStepId(stepId)
  const setup = parseSetupRecord(value)
  const steps = isRecord(setup.steps) ? setup.steps : null
  const builder = steps && isRecord(steps.builder) ? steps.builder : null
  if (!path || !builder)
    return null
  const platform = builder[path.platform]
  if (!isRecord(platform))
    return null
  const step = platform[path.step]
  return isRecord(step) ? step : null
}

function applyBuilderStepPatches(
  stepPaths: Record<string, unknown>,
  patches: AppOnboardingPatch['builderSteps'],
  now: () => string,
): Record<string, unknown> {
  if (!patches || !isRecord(stepPaths.builder))
    return stepPaths

  const nextPaths = { ...stepPaths }
  const builder = { ...stepPaths.builder }
  for (const [stepId, value] of Object.entries(patches)) {
    const path = parseBuilderStepId(stepId)
    if (!path || !value)
      continue
    const currentPlatform = builder[path.platform]
    if (!isRecord(currentPlatform))
      continue
    const platform: Record<string, unknown> = { ...currentPlatform }
    const currentStep = platform[path.step]
    if (!isRecord(currentStep))
      continue

    const nextStep: Record<string, unknown> = { ...currentStep, status: value.status }
    if (value.status === 'pending') {
      delete nextStep.at
      delete nextStep.update_history
      delete nextStep.annotation
      delete nextStep.annotation_type
    }
    else {
      nextStep.at = value.at ?? now()
      if (value.annotation)
        nextStep.annotation = value.annotation
      else
        delete nextStep.annotation
      if (value.annotationType)
        nextStep.annotation_type = value.annotationType
      else
        delete nextStep.annotation_type
    }
    platform[path.step] = nextStep
    builder[path.platform] = platform
  }
  nextPaths.builder = builder
  return nextPaths
}

export function applyAppOnboardingPatch(
  currentValue: unknown,
  patch: AppOnboardingPatch,
  now = () => new Date().toISOString(),
): Record<string, unknown> {
  const existing = isRecord(currentValue) ? { ...currentValue } : {}
  const setup = mergeAppOnboarding(existing.setup ?? existing, patch, now)
  const rawSetup = parseSetupRecord(currentValue)
  const rawSteps = isRecord(rawSetup.steps) ? rawSetup.steps : {}
  const isV4 = setup.todo_list_version === 4
  const isOtaV1 = isV4 && setup.ota_todo_list_version === APP_ONBOARDING_OTA_V1_VERSION
  const rawCurrentSteps = isOtaV1 && isRecord(rawSteps.ota) ? rawSteps.ota : rawSteps
  for (const id of Object.keys(setup.steps) as AppOnboardingStepId[]) {
    if (patch.steps?.[id]?.status !== 'pending' && isRecord(rawCurrentSteps[id]))
      setup.steps[id] = { ...rawCurrentSteps[id], ...setup.steps[id]! }
  }
  delete existing.source
  delete existing.outcome
  delete existing.steps
  delete existing.updated_at
  delete existing.todo_list_version
  delete existing.ota_todo_list_version
  const mergedStepPaths = isV4
    ? applyBuilderStepPatches({ ...rawSteps, ...(isOtaV1 ? { ota: setup.steps } : {}) }, patch.builderSteps, now)
    : setup.steps
  return {
    ...existing,
    setup: isV4
      ? { ...rawSetup, ...setup, ...(isOtaV1 ? { paths: rawSetup.paths ?? ['ota'], selected_path: rawSetup.selected_path ?? 'ota' } : {}), steps: mergedStepPaths }
      : setup,
  }
}

function getRawStepRecords(value: unknown): Record<string, unknown> {
  const setup = parseSetupRecord(value)
  const steps = isRecord(setup.steps) ? setup.steps : {}
  if (parseTodoListVersion(setup.todo_list_version) !== 4)
    return steps
  return setup.ota_todo_list_version === APP_ONBOARDING_OTA_V1_VERSION && isRecord(steps.ota) ? steps.ota : {}
}

export function appendAppOnboardingStepHistory(
  currentValue: unknown,
  mergedValue: unknown,
  patch: AppOnboardingPatch,
  now = () => new Date().toISOString(),
): Record<string, unknown> {
  const merged = isRecord(mergedValue) ? { ...mergedValue } : {}
  const mergedSetup = parseSetupRecord(merged)
  const isV4 = parseTodoListVersion(mergedSetup.todo_list_version) === 4
  const isOtaV4 = isV4 && mergedSetup.ota_todo_list_version === APP_ONBOARDING_OTA_V1_VERSION
  const mergedStepPaths = isRecord(mergedSetup.steps) ? { ...mergedSetup.steps } : {}
  const mergedSteps = { ...getRawStepRecords(merged) }
  const currentStepRecords = getRawStepRecords(currentValue)
  const changedAt = now()

  for (const stepId of Object.keys(patch.steps ?? {}) as AppOnboardingStepId[]) {
    const nextStep = mergedSteps[stepId]
    if (!isRecord(nextStep) || !STEP_STATUS_SET.has(String(nextStep.status)))
      continue

    const currentStep = isRecord(currentStepRecords[stepId]) ? currentStepRecords[stepId] : {}
    const history = appendStepHistory(currentStep, nextStep, changedAt)
    mergedSteps[stepId] = history.length > 0 ? { ...nextStep, update_history: history } : nextStep
  }

  let outputSteps: Record<string, unknown> = isOtaV4 ? { ...mergedStepPaths, ota: mergedSteps } : isV4 ? mergedStepPaths : mergedSteps
  if (isV4 && patch.builderSteps && isRecord(outputSteps.builder)) {
    const builder = { ...outputSteps.builder }
    for (const stepId of Object.keys(patch.builderSteps)) {
      const path = parseBuilderStepId(stepId)
      if (!path)
        continue
      const currentPlatform = builder[path.platform]
      if (!isRecord(currentPlatform))
        continue
      const platform: Record<string, unknown> = { ...currentPlatform }
      const nextStepValue = platform[path.step]
      if (!isRecord(nextStepValue) || !HISTORY_STEP_STATUS_SET.has(String(nextStepValue.status)))
        continue
      const currentStep = getBuilderStepRecord(currentValue, stepId) ?? {}
      const history = appendStepHistory(currentStep, nextStepValue, changedAt)
      platform[path.step] = history.length > 0 ? { ...nextStepValue, update_history: history } : nextStepValue
      builder[path.platform] = platform
    }
    outputSteps = { ...outputSteps, builder }
  }

  return {
    ...merged,
    setup: {
      ...mergedSetup,
      steps: outputSteps,
    },
  }
}

export function getAppOnboardingStepHistoryChanges(
  currentValue: unknown,
  nextValue: unknown,
  patch: AppOnboardingPatch,
): AppOnboardingStepHistoryChange[] {
  const currentSteps = getRawStepRecords(currentValue)
  const nextSteps = getRawStepRecords(nextValue)

  const otaChanges = (Object.keys(patch.steps ?? {}) as AppOnboardingStepId[]).flatMap((stepId) => {
    const currentStep = isRecord(currentSteps[stepId]) ? currentSteps[stepId] : {}
    const nextStep = isRecord(nextSteps[stepId]) ? nextSteps[stepId] : null
    if (!nextStep || !STEP_STATUS_SET.has(String(nextStep.status)))
      return []

    const currentHistory = parseStepHistory(currentStep.update_history)
    const nextHistory = parseStepHistory(nextStep.update_history)
    const latest = nextHistory.at(-1)
    if (!latest || JSON.stringify(currentHistory) === JSON.stringify(nextHistory))
      return []

    return [{
      stepId,
      status: nextStep.status as Exclude<AppOnboardingBuilderStepStatus, 'pending'>,
      at: latest.at,
      historyLength: nextHistory.length,
      historyFull: 'type' in latest,
    }]
  })

  const builderChanges = (Object.keys(patch.builderSteps ?? {}) as AppOnboardingBuilderStepId[]).flatMap((stepId) => {
    const currentStep = getBuilderStepRecord(currentValue, stepId) ?? {}
    const nextStep = getBuilderStepRecord(nextValue, stepId)
    if (!nextStep || !HISTORY_STEP_STATUS_SET.has(String(nextStep.status)))
      return []

    const currentHistory = parseStepHistory(currentStep.update_history)
    const nextHistory = parseStepHistory(nextStep.update_history)
    const latest = nextHistory.at(-1)
    if (!latest || JSON.stringify(currentHistory) === JSON.stringify(nextHistory))
      return []

    return [{
      stepId,
      status: nextStep.status as Exclude<AppOnboardingBuilderStepStatus, 'pending'>,
      at: latest.at,
      historyLength: nextHistory.length,
      historyFull: 'type' in latest,
    }]
  })

  return [...otaChanges, ...builderChanges]
}

// These v3/v4 milestones require observed backend evidence, not init prompt completion.
export function filterAppOnboardingReportedPatch(current: unknown, patch: AppOnboardingPatch): AppOnboardingPatch {
  if (!hasSupportedOtaTodoList(parseAppOnboarding(current)))
    return patch
  const steps = { ...patch.steps }
  delete steps.run_device
  delete steps.upload_bundle
  delete steps.test_update
  return { ...patch, steps }
}
