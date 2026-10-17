import { ref } from 'vue'
import { defaultApiHost, useConsole } from '~/services/console'

export interface CheckDomainResponse {
  has_sso: boolean
  provider_id?: string
  org_id?: string
}

export function useSSORouting() {
  const supabase = useConsole()
  const hasSso = ref(false)
  const isChecking = ref(false)
  const error = ref<string | null>(null)

  async function checkDomain(email: string): Promise<boolean> {
    isChecking.value = true
    error.value = null

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData?.session?.access_token

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      const response = await fetch(`${defaultApiHost}/private/sso/check-domain`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email }),
      })

      if (!response.ok) {
        hasSso.value = false
        return false
      }

      const result = await response.json() as CheckDomainResponse
      hasSso.value = result.has_sso
      return result.has_sso
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to check domain'
      hasSso.value = false
      return false
    }
    finally {
      isChecking.value = false
    }
  }

  async function redirectToSSO(domain: string): Promise<void> {
    error.value = null

    try {
      const { data, error: ssoError } = await supabase.auth.signInWithSSO({
        domain,
        options: {
          redirectTo: `${window.location.origin}/sso-callback`,
        },
      })

      if (ssoError) {
        error.value = ssoError.message
        return
      }

      if (data?.url) {
        window.location.href = data.url
      }
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : 'SSO login failed'
    }
  }

  return { hasSso, isChecking, error, checkDomain, redirectToSSO }
}
