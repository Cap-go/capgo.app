import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { invokeCapgoApi } from '~/services/capgoApi'

type TranslateFn = (key: string, params?: Record<string, unknown> | string, defaultMsg?: string) => string

export async function resolveInviteNewUserErrorMessage(
  error: unknown,
  t: TranslateFn,
  options: { cancelledFallback?: string } = {},
): Promise<string | null> {
  if (!(error instanceof FunctionsHttpError) || !(error.context instanceof Response))
    return null

  let json: { error?: string, moreInfo?: { reason?: string, cooldown_minutes?: number } } | null = null
  try {
    json = await error.context.clone().json()
  }
  catch {
    return null
  }

  if (json?.error !== 'user_already_invited')
    return null

  const moreInfo = json.moreInfo
  if (moreInfo?.reason === 'invite_cancelled_recently') {
    if (options.cancelledFallback)
      return t('too-recent-invitation-cancelation', options.cancelledFallback)
    return t('too-recent-invitation-cancelation')
  }

  const rawCooldown = moreInfo?.cooldown_minutes
  const cooldownMinutes = Number.isFinite(rawCooldown) ? Number(rawCooldown) : 5
  return t('invitation-resend-wait', { minutes: cooldownMinutes })
}

export async function notifyExistingUserInvite(
  supabase: SupabaseClient<Database>,
  email: string,
  orgId: string,
): Promise<boolean> {
  const { error } = await invokeCapgoApi('private/invite_existing_user_to_org', {
    client: supabase,
    body: {
      email,
      org_id: orgId,
    },
  })

  if (error) {
    console.error('Failed to send organization invite email to existing user:', error)
    return false
  }

  return true
}

export function shouldAttemptExistingUserInviteNotification(
  output: string,
  hasPendingInvite = false,
) {
  if (output === 'ALREADY_INVITED')
    return hasPendingInvite

  if (output !== 'OK')
    return false

  return true
}

interface InviteSessionTokens {
  access_token: string
  refresh_token: string
}

interface InviteSessionStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const INVITE_SESSION_HANDOFF_KEY = 'capgo-invite-session-handoff'

/**
 * Same-origin stash for invite → /login session handoff.
 *
 * Do not put tokens on the login URL. SPA navigation keeps document.referrer
 * as the email client (or empty), so login.vue would show the leaked-session
 * warning from #2830. sessionStorage is first-party and not in history.
 */
export function stashInviteSessionHandoff(
  tokens: InviteSessionTokens,
  storage: Pick<InviteSessionStorage, 'setItem'> = globalThis.sessionStorage,
) {
  storage.setItem(INVITE_SESSION_HANDOFF_KEY, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  }))
}

export function takeInviteSessionHandoff(
  storage: Pick<InviteSessionStorage, 'getItem' | 'removeItem'> = globalThis.sessionStorage,
): InviteSessionTokens | null {
  const raw = storage.getItem(INVITE_SESSION_HANDOFF_KEY)
  storage.removeItem(INVITE_SESSION_HANDOFF_KEY)
  if (!raw)
    return null

  try {
    const parsed = JSON.parse(raw) as Partial<InviteSessionTokens>
    if (typeof parsed.access_token === 'string' && typeof parsed.refresh_token === 'string') {
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
      }
    }
  }
  catch {
    return null
  }

  return null
}

export async function completeInviteSessionHandoff(
  goToLogin: () => unknown,
  tokens: InviteSessionTokens,
  storage?: Pick<InviteSessionStorage, 'setItem'>,
): Promise<void> {
  try {
    stashInviteSessionHandoff(tokens, storage)
  }
  catch (error) {
    console.error('Failed to stash invite session', error)
  }
  await goToLogin()
}
