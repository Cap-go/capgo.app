import type {
  OnboardingAnalyticsFlow,
  OnboardingDevelopmentEnvironment,
  OnboardingIntent,
} from '~/utils/onboardingProgressAnalytics'

export const USER_ONBOARDING_STATUSES = ['in_progress', 'completed', 'abandoned'] as const
export const USER_ONBOARDING_STEPS = ['intent', 'details', 'organization', 'choice', 'install', 'setup'] as const
export const USER_ONBOARDING_FLOWS = ['pre_org', 'existing_org'] as const
export const USER_ONBOARDING_DEVELOPMENT_ENVIRONMENTS = ['hosted_builder', 'local_project', 'exploring'] as const satisfies readonly OnboardingDevelopmentEnvironment[]
export const USER_ONBOARDING_INTENTS = ['ota', 'builder', 'both', 'exploring'] as const
export const USER_ONBOARDING_DETAILS_STEPS = ['name', 'app_id', 'icon'] as const

export type UserOnboardingStatus = typeof USER_ONBOARDING_STATUSES[number]
export type UserOnboardingStep = typeof USER_ONBOARDING_STEPS[number]
export type UserOnboardingDetailsStep = typeof USER_ONBOARDING_DETAILS_STEPS[number]

export interface UserOnboardingProgress {
  status: UserOnboardingStatus
  step: UserOnboardingStep
  flow: OnboardingAnalyticsFlow
  development_environment?: OnboardingDevelopmentEnvironment
  intent?: OnboardingIntent
  details_step?: UserOnboardingDetailsStep
  app_name?: string
  app_id?: string
  existing_app?: boolean | null
  existing_app_setup?: 'import' | 'manual' | null
  store_url?: string
  imported_store_app_id?: string
  org_name?: string
  estimated_users_index?: number | null
  onboarding_attempt_id?: string
  last_run_id?: string
  updated_at: string
  completed_at?: string
}

export const USER_ONBOARDING_PROGRESS_FIELDS = {
  app_id: true,
  app_name: true,
  completed_at: true,
  details_step: true,
  development_environment: true,
  estimated_users_index: true,
  existing_app: true,
  existing_app_setup: true,
  flow: true,
  imported_store_app_id: true,
  intent: true,
  last_run_id: true,
  onboarding_attempt_id: true,
  org_name: true,
  status: true,
  step: true,
  store_url: true,
  updated_at: true,
} as const satisfies Record<keyof UserOnboardingProgress, true>

export interface UserOnboardingProgressInput {
  status: UserOnboardingStatus
  step: UserOnboardingStep
  flow: OnboardingAnalyticsFlow
  developmentEnvironment?: OnboardingDevelopmentEnvironment | null
  intent?: OnboardingIntent | null
  detailsStep?: UserOnboardingDetailsStep
  appName?: string
  appId?: string
  existingApp?: boolean | null
  existingAppSetup?: 'import' | 'manual' | null
  storeUrl?: string
  importedStoreAppId?: string
  orgName?: string
  estimatedUsersIndex?: number | null
  onboardingAttemptId?: string
  lastRunId?: string
  updatedAt?: string
  completedAt?: string | null
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

// Leave headroom: PostgreSQL jsonb::text is slightly larger than JSON.stringify.
export const USER_ONBOARDING_MAX_JSON_BYTES = 8000
const OPTIONAL_STRING_KEYS = ['store_url', 'org_name', 'app_name', 'app_id', 'imported_store_app_id'] as const
const onboardingAttemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const onboardingRunIdPattern = /^ir_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function truncateToCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('')
}

function optionalTrimmedString(value: unknown, maxLength = 1024): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  if (!trimmed)
    return undefined
  return Array.from(trimmed).length > maxLength ? truncateToCodePoints(trimmed, maxLength) : trimmed
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function clampOnboardingPayload(progress: UserOnboardingProgress): UserOnboardingProgress {
  for (const key of OPTIONAL_STRING_KEYS) {
    while (jsonByteLength(progress) > USER_ONBOARDING_MAX_JSON_BYTES) {
      const current = progress[key]
      if (!current)
        break
      const chars = Array.from(current)
      if (chars.length <= 1) {
        delete progress[key]
        break
      }
      progress[key] = chars.slice(0, Math.floor(chars.length / 2)).join('')
    }
    if (jsonByteLength(progress) <= USER_ONBOARDING_MAX_JSON_BYTES)
      return progress
  }
  return progress
}

function optionalBoolean(value: unknown): boolean | null | undefined {
  if (value === null)
    return null
  if (typeof value === 'boolean')
    return value
  return undefined
}

function optionalIndex(value: unknown): number | null | undefined {
  if (value === null)
    return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
    return value
  return undefined
}

function applyOptionalUserOnboardingFields(
  progress: UserOnboardingProgress,
  raw: Record<string, unknown>,
): UserOnboardingProgress {
  if (isOneOf(raw.development_environment, USER_ONBOARDING_DEVELOPMENT_ENVIRONMENTS))
    progress.development_environment = raw.development_environment

  if (isOneOf(raw.intent, USER_ONBOARDING_INTENTS))
    progress.intent = raw.intent

  if (isOneOf(raw.details_step, USER_ONBOARDING_DETAILS_STEPS))
    progress.details_step = raw.details_step

  const appName = optionalTrimmedString(raw.app_name)
  if (appName)
    progress.app_name = appName

  const appId = optionalTrimmedString(raw.app_id)
  if (appId)
    progress.app_id = appId

  const existingApp = optionalBoolean(raw.existing_app)
  if (existingApp !== undefined)
    progress.existing_app = existingApp

  if (raw.existing_app_setup === 'import' || raw.existing_app_setup === 'manual' || raw.existing_app_setup === null)
    progress.existing_app_setup = raw.existing_app_setup

  const storeUrl = optionalTrimmedString(raw.store_url)
  if (storeUrl)
    progress.store_url = storeUrl

  const importedStoreAppId = optionalTrimmedString(raw.imported_store_app_id)
  if (importedStoreAppId)
    progress.imported_store_app_id = importedStoreAppId

  const orgName = optionalTrimmedString(raw.org_name)
  if (orgName)
    progress.org_name = orgName

  const estimatedUsersIndex = optionalIndex(raw.estimated_users_index)
  if (estimatedUsersIndex !== undefined)
    progress.estimated_users_index = estimatedUsersIndex

  const completedAt = optionalTrimmedString(raw.completed_at)
  if (completedAt)
    progress.completed_at = completedAt

  return progress
}

export function parseUserOnboardingProgress(value: unknown): UserOnboardingProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null

  const raw = value as Record<string, unknown>
  if (!isOneOf(raw.status, USER_ONBOARDING_STATUSES))
    return null
  if (!isOneOf(raw.step, USER_ONBOARDING_STEPS))
    return null
  if (!isOneOf(raw.flow, USER_ONBOARDING_FLOWS))
    return null

  const progress = applyOptionalUserOnboardingFields({
    status: raw.status,
    step: raw.step,
    flow: raw.flow,
    updated_at: typeof raw.updated_at === 'string' && raw.updated_at.trim()
      ? raw.updated_at
      : new Date(0).toISOString(),
  }, raw)

  const onboardingAttemptId = optionalTrimmedString(raw.onboarding_attempt_id, 64)
  if (onboardingAttemptId && onboardingAttemptIdPattern.test(onboardingAttemptId))
    progress.onboarding_attempt_id = onboardingAttemptId

  const lastRunId = optionalTrimmedString(raw.last_run_id, 67)
  if (lastRunId && onboardingRunIdPattern.test(lastRunId))
    progress.last_run_id = lastRunId

  return progress
}

export function buildUserOnboardingProgress(input: UserOnboardingProgressInput): UserOnboardingProgress {
  const progress: UserOnboardingProgress = {
    status: input.status,
    step: input.step,
    flow: input.flow,
    updated_at: input.updatedAt ?? new Date().toISOString(),
  }

  if (input.intent)
    progress.intent = input.intent

  if (input.developmentEnvironment)
    progress.development_environment = input.developmentEnvironment

  if (input.detailsStep)
    progress.details_step = input.detailsStep

  const appName = optionalTrimmedString(input.appName)
  if (appName)
    progress.app_name = appName

  const appId = optionalTrimmedString(input.appId)
  if (appId)
    progress.app_id = appId

  if (input.existingApp !== undefined)
    progress.existing_app = input.existingApp

  if (input.existingAppSetup !== undefined)
    progress.existing_app_setup = input.existingAppSetup

  const storeUrl = optionalTrimmedString(input.storeUrl)
  if (storeUrl)
    progress.store_url = storeUrl

  const importedStoreAppId = optionalTrimmedString(input.importedStoreAppId)
  if (importedStoreAppId)
    progress.imported_store_app_id = importedStoreAppId

  const orgName = optionalTrimmedString(input.orgName)
  if (orgName)
    progress.org_name = orgName

  if (input.estimatedUsersIndex !== undefined)
    progress.estimated_users_index = input.estimatedUsersIndex

  if (input.onboardingAttemptId && onboardingAttemptIdPattern.test(input.onboardingAttemptId))
    progress.onboarding_attempt_id = input.onboardingAttemptId

  if (input.lastRunId && onboardingRunIdPattern.test(input.lastRunId))
    progress.last_run_id = input.lastRunId

  if (input.status === 'completed')
    progress.completed_at = optionalTrimmedString(input.completedAt) ?? progress.updated_at

  return clampOnboardingPayload(progress)
}

export function clampResumableOnboardingStep(
  step: UserOnboardingStep,
  flow: OnboardingAnalyticsFlow,
): UserOnboardingStep {
  if (flow === 'pre_org' && (step === 'choice' || step === 'install' || step === 'setup'))
    return 'organization'
  return step
}

export function shouldPromptOnboardingResume(
  progress: UserOnboardingProgress | null,
  flow: OnboardingAnalyticsFlow,
): boolean {
  if (progress?.status !== 'in_progress' || progress.flow !== flow)
    return false

  const firstStep = flow === 'pre_org' ? 'intent' : 'details'
  if (progress.step !== firstStep)
    return true

  return Boolean(
    progress.development_environment
    || progress.intent
    || (progress.details_step !== undefined && progress.details_step !== 'name')
    || progress.app_name
    || progress.existing_app === true
    || progress.existing_app === false
    || progress.org_name,
  )
}
