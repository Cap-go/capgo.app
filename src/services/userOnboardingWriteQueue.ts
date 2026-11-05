import type { Json } from '~/types/database.types'
import { useConsole } from '~/services/console'
import { USER_ONBOARDING_INTENTS, USER_ONBOARDING_PROGRESS_FIELDS } from '~/utils/userOnboardingProgress'

const onboardingWriteChains = new Map<string, Promise<void>>()

export const MAX_USER_ONBOARDING_WRITE_ATTEMPTS = 3

interface MergeUserOnboardingProgressOptions {
  clearIntent?: boolean
  clearProfileDraft?: boolean
}

function isJsonObject(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeUserOnboardingProgress(
  nextProgress: Json,
  currentOnboarding: Json | undefined,
  options: MergeUserOnboardingProgressOptions = {},
): Json {
  const merged = isJsonObject(currentOnboarding) ? { ...currentOnboarding } : {}
  const currentIntent = USER_ONBOARDING_INTENTS.find(intent => merged.intent === intent)
  for (const key of Object.keys(USER_ONBOARDING_PROGRESS_FIELDS))
    delete merged[key]

  if (options.clearProfileDraft) {
    delete merged.profile_draft
    delete merged.profile_completed_at
  }

  const next = isJsonObject(nextProgress) ? { ...nextProgress } : {}
  if (options.clearIntent) {
    delete merged.intent
    delete next.intent
  }
  return {
    ...merged,
    ...(!options.clearIntent && currentIntent && next.intent === undefined ? { intent: currentIntent } : {}),
    ...next,
  }
}

export function serializeUserOnboardingWrite<T>(
  userId: string,
  write: () => Promise<T>,
): Promise<T> {
  const previousWrite = onboardingWriteChains.get(userId) ?? Promise.resolve()
  const result = previousWrite.then(write)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )

  onboardingWriteChains.set(userId, settled)
  void settled.then(() => {
    if (onboardingWriteChains.get(userId) === settled)
      onboardingWriteChains.delete(userId)
  })

  return result
}

export async function replaceUserOnboardingIfUnchanged(
  userId: string,
  expectedOnboarding: Json,
  onboarding: Json,
) {
  return useConsole()
    .from('users')
    .update({ onboarding })
    .eq('id', userId)
    .filter('onboarding', 'eq', JSON.stringify(expectedOnboarding))
    .select()
    .maybeSingle()
}

export type ReplaceUserOnboardingWithRetryResult
  = | { status: 'persisted', onboarding: Json }
    | { status: 'skipped' }
    | { status: 'conflict' }
    | { status: 'error', error: unknown }

export async function replaceUserOnboardingWithRetry(
  userId: string,
  initialOnboarding: Json,
  buildOnboarding: (current: Json) => Json,
  shouldContinue: (current: Json) => boolean,
  retryError?: (error: unknown) => boolean,
): Promise<ReplaceUserOnboardingWithRetryResult> {
  let currentOnboarding = initialOnboarding
  const capgo = useConsole()

  for (let attempt = 0; attempt < MAX_USER_ONBOARDING_WRITE_ATTEMPTS; attempt++) {
    if (!shouldContinue(currentOnboarding))
      return { status: 'skipped' }

    const onboarding = buildOnboarding(currentOnboarding)
    const { data, error } = await replaceUserOnboardingIfUnchanged(userId, currentOnboarding, onboarding)
    if (error) {
      if (retryError?.(error))
        continue
      return { status: 'error', error }
    }

    if (data)
      return { status: 'persisted', onboarding: data.onboarding }

    const { data: latest, error: latestError } = await capgo.from('users').select('onboarding').eq('id', userId).maybeSingle()
    if (latestError || !latest)
      return { status: 'error', error: latestError ?? new Error('onboarding_write_missing_user') }

    currentOnboarding = latest.onboarding
  }

  return { status: 'conflict' }
}
