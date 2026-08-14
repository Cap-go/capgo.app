import type {
  OnboardingAnalyticsFlow,
  OnboardingAnalyticsStep,
  OnboardingIntent,
} from '~/utils/onboardingProgressAnalytics'

export const USER_ONBOARDING_STATUSES = ['in_progress', 'completed', 'abandoned'] as const
export const USER_ONBOARDING_STEPS = ['intent', 'details', 'organization', 'choice', 'install', 'setup'] as const
export const USER_ONBOARDING_FLOWS = ['pre_org', 'existing_org'] as const
export const USER_ONBOARDING_INTENTS = ['ota', 'builder', 'both', 'exploring'] as const

export type UserOnboardingStatus = typeof USER_ONBOARDING_STATUSES[number]

export interface UserOnboardingProgress {
  status: UserOnboardingStatus
  step: OnboardingAnalyticsStep
  flow: OnboardingAnalyticsFlow
  intent?: OnboardingIntent
  app_name?: string
  app_id?: string
  existing_app?: boolean | null
  existing_app_setup?: 'import' | 'manual' | null
  store_url?: string
  imported_store_app_id?: string
  org_name?: string
  estimated_users_index?: number | null
  updated_at: string
  completed_at?: string
}

export interface UserOnboardingProgressInput {
  status: UserOnboardingStatus
  step: OnboardingAnalyticsStep
  flow: OnboardingAnalyticsFlow
  intent?: OnboardingIntent | null
  appName?: string
  appId?: string
  existingApp?: boolean | null
  existingAppSetup?: 'import' | 'manual' | null
  storeUrl?: string
  importedStoreAppId?: string
  orgName?: string
  estimatedUsersIndex?: number | null
  updatedAt?: string
  completedAt?: string | null
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

export const USER_ONBOARDING_MAX_JSON_BYTES = 8192
const OPTIONAL_STRING_KEYS = ['store_url', 'org_name', 'app_name', 'app_id', 'imported_store_app_id'] as const

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
  if (isOneOf(raw.intent, USER_ONBOARDING_INTENTS))
    progress.intent = raw.intent

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

  return applyOptionalUserOnboardingFields({
    status: raw.status,
    step: raw.step,
    flow: raw.flow,
    updated_at: typeof raw.updated_at === 'string' && raw.updated_at.trim()
      ? raw.updated_at
      : new Date(0).toISOString(),
  }, raw)
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

  if (input.status === 'completed')
    progress.completed_at = optionalTrimmedString(input.completedAt) ?? progress.updated_at

  return clampOnboardingPayload(progress)
}

export function clampResumableOnboardingStep(
  step: OnboardingAnalyticsStep,
  flow: OnboardingAnalyticsFlow,
): OnboardingAnalyticsStep {
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
    progress.intent
    || progress.app_name
    || progress.existing_app === true
    || progress.existing_app === false
    || progress.org_name,
  )
}
