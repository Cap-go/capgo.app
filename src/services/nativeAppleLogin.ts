import type { ConsoleClient, Session, User } from './consoleClient'
import { Capacitor } from '@capacitor/core'
import { defaultApiHost } from './console'

interface NativeAppleAuthClient {
  auth: Pick<ConsoleClient['auth'], 'setSession' | 'getSession'>
}

export function isNativeAppleLoginAvailable(reauthenticate = false) {
  return (reauthenticate || import.meta.env.VITE_NATIVE_APPLE_LOGIN_ENABLED === 'true')
    && Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'ios'
    && Capacitor.isPluginAvailable('SocialLogin')
}

export async function signInWithApple(supabase: NativeAppleAuthClient, captchaToken?: string, options: { reauthenticate?: boolean } = {}) {
  if (!isNativeAppleLoginAvailable(options.reauthenticate))
    throw new Error('Apple login requires the native iOS SocialLogin plugin')

  const { SocialLogin } = await import('@capgo/capacitor-social-login')
  await SocialLogin.initialize({ apple: { useProperTokenExchange: true } })

  // Apple receives the hash; Supabase verifies it against this attempt's raw nonce.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  const hashedNonce = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  let credential
  try {
    credential = await SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'], nonce: hashedNonce } })
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'USER_CANCELLED')
      return null
    throw error
  }

  if (!credential.result.idToken)
    throw new Error('Apple did not return an identity token')

  let currentSession: Session | null = null
  if (options.reauthenticate) {
    const { data } = await supabase.auth.getSession()
    currentSession = data.session
  }
  if (options.reauthenticate && !currentSession)
    throw new Error('Authentication required')
  const response = await fetch(`${defaultApiHost}/auth/apple`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(currentSession ? { Authorization: `Bearer ${currentSession.access_token}` } : {}),
    },
    body: JSON.stringify({
      id_token: credential.result.idToken,
      nonce,
      first_name: credential.result.profile.givenName ?? undefined,
      last_name: credential.result.profile.familyName ?? undefined,
      captcha_token: captchaToken,
      reauthenticate: options.reauthenticate,
      registration_metadata: { registration_device_type: 'mobile', registration_os: 'iOS', registration_browser: 'native' },
    }),
  })
  const result = await response.json() as {
    user?: User
    session?: { access_token: string, refresh_token: string }
    name_status?: 'saved' | 'unavailable'
    error?: string
  }
  if (!response.ok || !result.user || !result.session)
    throw new Error(result.error || 'Apple authentication failed')
  // Check again before installing a replacement session during account deletion.
  if (currentSession && result.user.id !== currentSession.user.id)
    throw new Error('Apple account does not match the authenticated account')
  const { data, error } = await supabase.auth.setSession(result.session)
  const installedUser = data.session?.user
  if (error || !installedUser)
    throw error || new Error('Apple session could not be installed')
  return { user: installedUser, profileSaveFailed: false, nameUnavailable: result.name_status === 'unavailable', authorizationCode: credential.result.authorizationCode }
}
