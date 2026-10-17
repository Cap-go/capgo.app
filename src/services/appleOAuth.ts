import type { ConsoleClient, User } from './consoleClient'
import { Capacitor } from '@capacitor/core'
import { base64url } from 'jose'
import { parseSignupAttributionRecord } from '../../supabase/functions/shared/signup-attribution'
import { defaultApiHost } from './console'

export interface AppleAuthSessionClient {
  auth: Pick<ConsoleClient['auth'], 'setSession'>
}

const storageKey = 'capgo.apple-oauth.v1'
const metadataKeys = ['registration_device_type', 'registration_os', 'registration_browser', 'registration_variant', 'registration_experiment', 'registration_experiment_variant']
interface PendingAppleOAuth {
  verifier: string
  state: string
  created: number
  websiteState?: string
  code?: string
}
let pendingCompletion: PendingAppleOAuth | null = null
let landingError = false

function readAttempt(): PendingAppleOAuth | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
    if (attempt && Date.now() - attempt.created < 600_000)
      return attempt
  }
  catch {}
  sessionStorage.removeItem(storageKey)
  return null
}

export function isWebAppleLoginAvailable() {
  return import.meta.env.VITE_WEB_APPLE_LOGIN_ENABLED === 'true'
    && !Capacitor.isNativePlatform() && location.protocol === 'https:'
}

export async function startAppleOAuth(url: URL) {
  if (!isWebAppleLoginAvailable())
    throw new Error('Apple login is unavailable')
  const redirectUri = `${location.origin}/login`
  const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const fields = Object.fromEntries(url.searchParams)
  const registrationMetadata: Record<string, string> = { ...parseSignupAttributionRecord(fields) }
  for (const key of metadataKeys) {
    const value = url.searchParams.get(key)
    if (value)
      registrationMetadata[key] = value.slice(0, 100)
  }
  const websiteState = url.searchParams.get('apple_website_state') ?? ''
  const attempt: PendingAppleOAuth = {
    verifier,
    state,
    created: Date.now(),
    ...(/^[\w-]{32,128}$/.test(websiteState) ? { websiteState } : {}),
  }
  sessionStorage.setItem(storageKey, JSON.stringify(attempt))
  const response = await fetch(`${defaultApiHost}/auth/apple/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uri: redirectUri, code_challenge: challenge, client_state: state, registration_metadata: registrationMetadata }),
  })
  const result = await response.json() as { authorization_url?: string }
  if (!response.ok || typeof result.authorization_url !== 'string')
    throw new Error('Apple login could not start')
  location.assign(result.authorization_url)
}

export function captureAppleOAuthCallback(url: URL) {
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (!fragment.has('apple_code') && !fragment.has('apple_error'))
    return false
  url.hash = ''
  history.replaceState({}, '', url)
  const attempt = readAttempt()
  sessionStorage.removeItem(storageKey)
  if (fragment.get('state') !== attempt?.state || fragment.has('apple_error')) {
    pendingCompletion = null
    throw new Error('Apple authorization failed')
  }
  const code = fragment.get('apple_code') ?? ''
  if (!/^[\w-]{43}$/.test(code))
    throw new Error('Apple authorization failed')
  // Keep the returned code and verifier together only in memory, never in storage.
  pendingCompletion = { ...attempt, code }
  return true
}

// Run before router and analytics startup so the callback never becomes a page URL.
export function prepareAppleOAuthLanding() {
  try {
    captureAppleOAuthCallback(new URL(location.href))
  }
  catch {
    pendingCompletion = null
    landingError = true
  }
}

export function consumeAppleOAuthLandingError() {
  const failed = landingError
  landingError = false
  return failed
}

export function hasPendingAppleOAuth() {
  return !!pendingCompletion?.code && Date.now() - pendingCompletion.created < 600_000
}

export async function completeAppleOAuth(supabase: AppleAuthSessionClient, captchaToken?: string) {
  const attempt = pendingCompletion
  pendingCompletion = null
  if (!attempt?.code)
    throw new Error('Apple authorization expired')
  const response = await fetch(`${defaultApiHost}/auth/apple/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: attempt.code, code_verifier: attempt.verifier, captcha_token: captchaToken }),
  })
  const result = await response.json() as {
    user: User
    session: { access_token: string, refresh_token: string }
    is_new_user: boolean
    name_status: 'saved' | 'unavailable'
  }
  if (!response.ok || !result.user || !result.session)
    throw new Error('Apple authentication failed')
  const { data, error } = await supabase.auth.setSession(result.session)
  const installedUser = data.session?.user
  if (error || !installedUser)
    throw error || new Error('Apple session could not be installed')
  if (attempt.websiteState && location.origin === 'https://console.capgo.app' && window.opener) {
    window.opener.postMessage({
      type: 'capgo:apple-auth-complete',
      state: attempt.websiteState,
      is_new_user: result.is_new_user,
      user: { id: result.user.id, email: result.user.email },
    }, 'https://capgo.app')
  }
  return result
}
