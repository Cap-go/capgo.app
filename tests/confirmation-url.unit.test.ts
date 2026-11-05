import { describe, expect, it } from 'vitest'
import { parseQuery } from 'vue-router'
import { resolveConfirmationUrl } from '../src/utils/safeRedirect.ts'

const options = { allowedHosts: ['console.capgo.app', 'sb.capgo.app'] }
const verificationUrl = 'https://sb.capgo.app/auth/v1/verify?token=recovery-regression'
const redirectTo = 'https://console.capgo.app/forgot_password?step=2'

describe('resolveConfirmationUrl', () => {
  it.concurrent('restores the misplaced parameters in the delivered recovery email', () => {
    const query = parseQuery(`confirmation_url=${encodeURIComponent(verificationUrl)}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}&utm_source=bento&bento_uuid=tracking-regression`)
    const resolved = resolveConfirmationUrl(query, options)
    const target = new URL(resolved!)

    expect(Object.fromEntries(target.searchParams)).toEqual({
      token: 'recovery-regression',
      type: 'recovery',
      redirect_to: redirectTo,
    })
  })

  it.concurrent('preserves encoding inside a complete verification URL', () => {
    const nestedRedirect = `${redirectTo}&next=${encodeURIComponent('/settings?tab=security&source=email')}`
    const completeUrl = `${verificationUrl}&type=recovery&redirect_to=${encodeURIComponent(nestedRedirect)}`
    const query = parseQuery(`confirmation_url=${encodeURIComponent(completeUrl)}`)

    expect(resolveConfirmationUrl(query, options)).toBe(completeUrl)
    expect(new URL(resolveConfirmationUrl(query, options)!).searchParams.get('redirect_to')).toBe(nestedRedirect)
  })

  it.concurrent('does not override parameters already in the verification URL', () => {
    const completeUrl = `${verificationUrl}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`

    expect(resolveConfirmationUrl({
      confirmation_url: completeUrl,
      type: 'signup',
      redirect_to: 'https://console.capgo.app/dashboard',
    }, options)).toBe(completeUrl)
  })

  it.concurrent('supports legacy links with an extra layer of URL encoding', () => {
    const completeUrl = `${verificationUrl}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`

    expect(resolveConfirmationUrl({ confirmation_url: encodeURIComponent(completeUrl) }, options)).toBe(completeUrl)
  })

  it.concurrent.each(['signup', 'invite', 'magiclink', 'email_change'])('restores misplaced parameters for %s emails', (type) => {
    const resolved = resolveConfirmationUrl({ confirmation_url: verificationUrl, type }, options)

    expect(new URL(resolved!).searchParams.get('type')).toBe(type)
  })

  it.concurrent('does not forward auth parameters to other allowed URL paths', () => {
    const confirmationUrl = 'https://console.capgo.app/confirm'

    expect(resolveConfirmationUrl({ confirmation_url: confirmationUrl, type: 'recovery', redirect_to: redirectTo }, options)).toBe(confirmationUrl)
  })

  it.concurrent.each([
    'https://evil.example/auth/v1/verify?token=regression',
    'https://sb.capgo.app.evil.example/auth/v1/verify?token=regression',
    'http://sb.capgo.app/auth/v1/verify?token=regression',
    'javascript:alert(1)',
    '//sb.capgo.app/auth/v1/verify?token=regression',
    'https%3A%2F%2Fsb.capgo.app%2Fauth%2Fv1%2Fverify%3Ftoken%3D%',
  ])('rejects an invalid confirmation URL: %s', (confirmationUrl) => {
    expect(resolveConfirmationUrl({ confirmation_url: confirmationUrl, type: 'recovery', redirect_to: redirectTo }, options)).toBeNull()
  })

  it.concurrent('rejects missing and duplicate confirmation URLs', () => {
    expect(resolveConfirmationUrl({}, options)).toBeNull()
    expect(resolveConfirmationUrl({ confirmation_url: null }, options)).toBeNull()
    expect(resolveConfirmationUrl({ confirmation_url: [verificationUrl, verificationUrl] }, options)).toBeNull()
  })

  it.concurrent('supports local HTTP verification endpoints only in development', () => {
    const query = { confirmation_url: 'http://127.0.0.1:54321/auth/v1/verify?token=regression', type: 'recovery' }

    expect(resolveConfirmationUrl(query, options)).toBeNull()
    expect(new URL(resolveConfirmationUrl(query, { ...options, allowLocalDev: true })!).searchParams.get('type')).toBe('recovery')
  })

  it.concurrent('relays verification links through the Capgo API when an API host is configured', () => {
    const relayOptions = { ...options, apiHost: 'https://api.capgo.app/' }
    const relayed = new URL(resolveConfirmationUrl({ confirmation_url: verificationUrl, type: 'recovery', redirect_to: redirectTo }, relayOptions)!)
    expect(relayed.origin).toBe('https://api.capgo.app')
    expect(relayed.pathname).toBe('/private/console/auth/verify')
    expect(relayed.searchParams.get('token')).toBe('recovery-regression')
    expect(relayed.searchParams.get('type')).toBe('recovery')
    expect(relayed.searchParams.get('redirect_to')).toBe(redirectTo)
    // The email host is irrelevant: only our own auth provider ever sees the token.
    expect(new URL(resolveConfirmationUrl({ confirmation_url: 'https://evil.example/auth/v1/verify?token=regression' }, relayOptions)!).origin).toBe('https://api.capgo.app')
    // Other links still need an approved host.
    expect(resolveConfirmationUrl({ confirmation_url: 'https://evil.example/login' }, relayOptions)).toBeNull()
  })
})
