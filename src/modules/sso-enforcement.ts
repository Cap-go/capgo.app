import type { UserModule } from '~/types'
import { defaultApiHost, getSpoofedAdminJwt, useSupabase } from '~/services/supabase'

interface SsoEnforcementResponse {
  allowed: boolean
  reason?: string
}

const SSO_CHECK_CACHE_KEY = 'sso_enforcement_checked_v2'
const SSO_CHECK_CACHE_TTL = 5 * 60 * 1000
const SPOOF_ADMIN_AUTHORIZATION_HEADER = 'X-Capgo-Spoof-Admin-Authorization'

const PUBLIC_ROUTES = [
  '/login',
  '/register',
  '/sso-callback',
  '/confirm-signup',
  '/forgot_password',
  '/onboarding/set_password',
  '/accountDisabled',
]

function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some(r => path === r || path.startsWith(`${r}/`))
}

function isCacheValid(userId: string): boolean {
  try {
    const cached = sessionStorage.getItem(SSO_CHECK_CACHE_KEY)
    if (!cached)
      return false
    const { timestamp, cachedUserId } = JSON.parse(cached)
    // Verify cache is fresh AND belongs to the current user
    return Date.now() - timestamp < SSO_CHECK_CACHE_TTL && cachedUserId === userId
  }
  catch {
    return false
  }
}

function setCacheValid(userId: string): void {
  try {
    sessionStorage.setItem(SSO_CHECK_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), cachedUserId: userId }))
  }
  catch {}
}

export function clearSsoEnforcementCache(): void {
  try {
    sessionStorage.removeItem(SSO_CHECK_CACHE_KEY)
  }
  catch {}
}

export const install: UserModule = ({ router }) => {
  router.beforeEach(async (to, _from, next) => {
    if (isPublicRoute(to.path))
      return next()

    // Local worktree/dev has no reliable edge-function path for SSO enforcement.
    // Skip the network check so password login works against seed users.
    // Vite injects branch as VITE_BRANCH (not ENV) into import.meta.env.
    if (import.meta.env.VITE_BRANCH === 'local')
      return next()

    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()

    if (!session)
      return next()

    const provider = session.user.app_metadata?.provider
    if (provider && provider !== 'email')
      return next()

    const userId = session.user.id
    if (!userId)
      return next()

    try {
      const spoofedAdminJwt = await getSpoofedAdminJwt()
      if (!spoofedAdminJwt && isCacheValid(userId))
        return next()

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      }
      if (spoofedAdminJwt)
        headers[SPOOF_ADMIN_AUTHORIZATION_HEADER] = `Bearer ${spoofedAdminJwt}`

      const response = await fetch(`${defaultApiHost}/private/sso/check-enforcement`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: session.user.email,
          auth_type: 'password',
        }),
      })

      if (!response.ok) {
        console.error('SSO enforcement check returned error status:', response.status)
        clearSsoEnforcementCache()
        await supabase.auth.signOut()
        return next('/login?sso_error=enforcement_check_failed')
      }

      const data: SsoEnforcementResponse = await response.json()
      if (!data.allowed) {
        clearSsoEnforcementCache()
        await supabase.auth.signOut()
        return next('/login?sso_required=true')
      }

      if (!spoofedAdminJwt)
        setCacheValid(userId)
    }
    catch (e) {
      // Fail closed: if enforcement check is unreachable, sign user out for safety
      console.error('SSO enforcement check failed, signing out for security:', e)
      clearSsoEnforcementCache()
      await supabase.auth.signOut()
      return next('/login?sso_error=enforcement_check_failed')
    }

    return next()
  })
}
