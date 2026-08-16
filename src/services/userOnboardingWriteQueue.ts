import type { Json } from '~/types/supabase.types'
import { useSupabase } from '~/services/supabase'

const onboardingWriteChains = new Map<string, Promise<void>>()

export const MAX_USER_ONBOARDING_WRITE_ATTEMPTS = 3

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
  let query = useSupabase()
    .from('users')
    .update({ onboarding })
    .eq('id', userId)

  query = expectedOnboarding === null
    ? query.is('onboarding', null)
    : query.filter('onboarding', 'eq', JSON.stringify(expectedOnboarding))

  return query
    .select()
    .maybeSingle()
}
