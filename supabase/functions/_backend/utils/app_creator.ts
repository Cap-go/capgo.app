import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { cloudlog } from './logging.ts'
import { supabaseAdmin } from './supabase.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function addAppCreatorToOnboarding(onboarding: unknown, userId: string): Record<string, unknown> {
  return {
    ...(isRecord(onboarding) ? onboarding : {}),
    created_by_user_id: userId,
  }
}

export function getAppCreatorUserId(onboarding: unknown): string | undefined {
  if (!isRecord(onboarding))
    return undefined
  const userId = onboarding.created_by_user_id
  return typeof userId === 'string' && UUID_PATTERN.test(userId) ? userId : undefined
}

export function buildAppCreatorEventDetails(onboarding: unknown, email?: string | null): Record<string, string> {
  const userId = getAppCreatorUserId(onboarding)
  if (!userId)
    return {}

  return {
    created_by_user_id: userId,
    ...(email ? { created_by_email: email } : {}),
  }
}

export async function resolveAppCreatorEventDetails(
  c: Context<MiddlewareKeyVariables>,
  onboarding: unknown,
): Promise<Record<string, string>> {
  const userId = getAppCreatorUserId(onboarding)
  if (!userId)
    return {}

  const { data, error } = await supabaseAdmin(c)
    .from('users')
    .select('email')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Cannot resolve app creator email for Bento event',
      error,
      user_id: userId,
    })
  }

  return buildAppCreatorEventDetails(onboarding, data?.email)
}
