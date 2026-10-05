import type { Session, User } from '@supabase/supabase-js'
import { defaultApiHost } from '~/services/supabase'

export interface SsoProvisioningResult {
  merged: boolean
  alreadyMember: boolean
  error: string | null
}

function isSsoProvider(provider: string | undefined): boolean {
  return !!provider && (provider === 'sso' || provider.startsWith('sso:'))
}

export function isSsoUser(user: Pick<User, 'app_metadata'> | null | undefined): boolean {
  const provider = typeof user?.app_metadata?.provider === 'string' ? user.app_metadata.provider : undefined
  const providers = Array.isArray(user?.app_metadata?.providers)
    ? user.app_metadata.providers.filter((item): item is string => typeof item === 'string')
    : []

  return isSsoProvider(provider) || providers.some(isSsoProvider)
}

// A stuck backend call must fail visibly instead of hanging navigation.
const PROVISIONING_TIMEOUT_MS = 15_000
export async function provisionSsoUser(session: Session): Promise<SsoProvisioningResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  // AbortSignal.timeout is missing on older WebViews.
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(PROVISIONING_TIMEOUT_MS)
    : (() => {
        const controller = new AbortController()
        timeout = setTimeout(() => controller.abort(), PROVISIONING_TIMEOUT_MS)
        return controller.signal
      })()
  try {
    const response = await fetch(`${defaultApiHost}/private/sso/provision-user`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as Record<string, unknown>
      // Prefer the human readable message (e.g. no access granted by the IdP).
      const errorMessage = typeof errorData.message === 'string'
        ? errorData.message
        : typeof errorData.error === 'string'
          ? errorData.error
          : `Provisioning failed (${response.status})`

      return {
        merged: false,
        alreadyMember: false,
        error: errorMessage,
      }
    }

    const provisionData = await response.json() as {
      success: boolean
      merged?: boolean
      already_member?: boolean
    }

    return {
      merged: provisionData.merged === true,
      alreadyMember: provisionData.already_member === true,
      error: null,
    }
  }
  catch (error) {
    return {
      merged: false,
      alreadyMember: false,
      error: error instanceof Error ? error.message : 'Provisioning request failed',
    }
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
  }
}
