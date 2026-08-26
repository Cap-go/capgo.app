const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function addAppCreatorToOnboarding(onboarding: unknown, userId: string, email?: string): Record<string, unknown> {
  return {
    ...(isRecord(onboarding) ? onboarding : {}),
    created_by_user_id: userId,
    ...(email ? { created_by_email: email } : {}),
  }
}

export function getAppCreatorUserId(onboarding: unknown): string | undefined {
  if (!isRecord(onboarding))
    return undefined
  const userId = onboarding.created_by_user_id
  return typeof userId === 'string' && UUID_PATTERN.test(userId) ? userId : undefined
}

export function buildAppCreatorEventDetails(onboarding: unknown): Record<string, string> {
  const userId = getAppCreatorUserId(onboarding)
  if (!userId)
    return {}

  const email = isRecord(onboarding) && typeof onboarding.created_by_email === 'string'
    ? onboarding.created_by_email
    : undefined

  return {
    created_by_user_id: userId,
    ...(email ? { created_by_email: email } : {}),
  }
}
