import type { SupabaseClient, User } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { defaultApiHost } from './supabase'

export function isNativeAppleLoginAvailable(reauthenticate = false) {
  return (reauthenticate || import.meta.env.VITE_NATIVE_APPLE_LOGIN_ENABLED === 'true')
    && Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'ios'
    && Capacitor.isPluginAvailable('SocialLogin')
}

export async function signInWithApple(supabase: SupabaseClient, captchaToken?: string, options: { reauthenticate?: boolean } = {}) {
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

  const { data: current } = options.reauthenticate ? await supabase.auth.getSession() : { data: { session: null } }
  if (options.reauthenticate && !current.session)
    throw new Error('Authentication required')
  const response = await fetch(`${defaultApiHost}/auth/apple`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(current.session ? { Authorization: `Bearer ${current.session.access_token}` } : {}),
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
  if (current.session && result.user.id !== current.session.user.id)
    throw new Error('Apple account does not match the authenticated account')
  const { data, error } = await supabase.auth.setSession(result.session)
  if (error || !data.user)
    throw error || new Error('Apple session could not be installed')
  return { user: data.user, profileSaveFailed: false, nameUnavailable: result.name_status === 'unavailable', authorizationCode: credential.result.authorizationCode }
}
