import type { UserModule } from '~/types'
import { defaultApiHost, getSpoofedAdminJwt, useConsole } from '~/services/console'

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

type SsoCheckOutcome = 'allowed' | 'sso_required' | 'check_failed'

interface SsoCheck {
  userId: string
  startedAt: number
  outcome: Promise<SsoCheckOutcome>
}

// A check started by prefetchSsoEnforcement() for the navigation in progress.
let pendingCheck: SsoCheck | undefined
const PENDING_CHECK_MAX_AGE = 30_000

async function currentSession() {
  const { data: { session } } = await useConsole().auth.getSession()
  if (!session)
    return null
  const provider = session.user.app_metadata?.provider
  if (provider && provider !== 'email')
    return null
  return session.user.id ? session : null
}

async function runCheck(session: NonNullable<Awaited<ReturnType<typeof currentSession>>>): Promise<SsoCheckOutcome> {
  const userId = session.user.id
  try {
    const spoofedAdminJwt = await getSpoofedAdminJwt()
    if (!spoofedAdminJwt && isCacheValid(userId))
      return 'allowed'

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
      return 'check_failed'
    }

    const data: SsoEnforcementResponse = await response.json()
    if (!data.allowed)
      return 'sso_required'

    if (!spoofedAdminJwt)
      setCacheValid(userId)
    return 'allowed'
  }
  catch (e) {
    // Fail closed: if enforcement check is unreachable, sign user out for safety
    console.error('SSO enforcement check failed, signing out for security:', e)
    return 'check_failed'
  }
}

/**
 * Starts the enforcement request as soon as a navigation begins, so it runs alongside the auth
 * guard's requests instead of after them. The guard below still awaits it and acts on the result.
 */
export function prefetchSsoEnforcement(path: string) {
  if (isPublicRoute(path))
    return
  void currentSession().then((session) => {
    if (session)
      pendingCheck = { userId: session.user.id, startedAt: Date.now(), outcome: runCheck(session) }
  }).catch(() => {})
}

export const install: UserModule = ({ router }) => {
  router.beforeEach(async (to, _from, next) => {
    if (isPublicRoute(to.path))
      return next()

    const session = await currentSession()
    if (!session)
      return next()

    const prefetched = pendingCheck
    pendingCheck = undefined
    const outcome = prefetched && prefetched.userId === session.user.id && Date.now() - prefetched.startedAt < PENDING_CHECK_MAX_AGE
      ? await prefetched.outcome
      : await runCheck(session)

    if (outcome === 'allowed')
      return next()

    clearSsoEnforcementCache()
    await useConsole().auth.signOut()
    return next(outcome === 'sso_required' ? '/login?sso_required=true' : '/login?sso_error=enforcement_check_failed')
  })
}
