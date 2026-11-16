const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveAppCreatorEmail(claimedEmail?: string, storedEmail?: string): string | undefined {
  return claimedEmail || storedEmail
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

/**
 * Identity for the server-side `App Created` PostHog event. Every creation path (console,
 * CLI, hosted MCP, public API) inserts through `public.apps`, so the insert trigger is the
 * one place it fires. Use the creator's user id, which is the distinct_id the console
 * identifies with, so the event lands on the same person; fall back to the org for rows
 * without a recorded creator (service-side inserts).
 */
export function buildAppCreatedTrackingIdentity(onboarding: unknown, orgId: string): { user_id: string, source: string } {
  // applyAppOnboardingPatch moves `source` under `setup`; older rows keep it at the top level.
  const setupSource = isRecord(onboarding) && isRecord(onboarding.setup) ? onboarding.setup.source : undefined
  const legacySource = isRecord(onboarding) ? onboarding.source : undefined
  const source = typeof setupSource === 'string' ? setupSource : typeof legacySource === 'string' ? legacySource : 'unknown'
  return { user_id: getAppCreatorUserId(onboarding) ?? orgId, source }
}
