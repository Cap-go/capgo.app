import type { Json } from '~/types/supabase.types'
import { useSupabase } from '~/services/supabase'
import { USER_ONBOARDING_PROGRESS_FIELDS } from '~/utils/userOnboardingProgress'

const onboardingWriteChains = new Map<string, Promise<void>>()

export const MAX_USER_ONBOARDING_WRITE_ATTEMPTS = 3

function isJsonObject(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeUserOnboardingProgress(nextProgress: Json, currentOnboarding: Json | undefined): Json {
  const merged = isJsonObject(currentOnboarding) ? { ...currentOnboarding } : {}
  for (const key of Object.keys(USER_ONBOARDING_PROGRESS_FIELDS))
    delete merged[key]

  return isJsonObject(nextProgress) ? { ...merged, ...nextProgress } : merged
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
  return useSupabase()
    .from('users')
    .update({ onboarding })
    .eq('id', userId)
    .filter('onboarding', 'eq', JSON.stringify(expectedOnboarding))
    .select()
    .maybeSingle()
}
