import { describe, expect, it } from 'vitest'
import {
  buildAuthConfirmationUrl,
  buildAuthEmailBentoDetails,
  getAuthEmailBentoEvent,
} from '../supabase/functions/_backend/utils/auth_email.ts'

describe('auth email Bento mapping', () => {
  it.concurrent('maps GoTrue action types to auth: events', () => {
    expect(getAuthEmailBentoEvent('signup')).toBe('auth:signup')
    expect(getAuthEmailBentoEvent('recovery')).toBe('auth:recovery')
    expect(getAuthEmailBentoEvent('magiclink')).toBe('auth:magiclink')
    expect(getAuthEmailBentoEvent('invite')).toBe('auth:invite')
    expect(getAuthEmailBentoEvent('email_change')).toBe('auth:email_change')
    expect(getAuthEmailBentoEvent('password_changed_notification')).toBe('auth:password_changed')
    expect(getAuthEmailBentoEvent('mfa_factor_enrolled_notification')).toBe('auth:mfa_factor_enrolled')
  })

  it.concurrent('keeps unknown action types instead of dropping the email', () => {
    expect(getAuthEmailBentoEvent('custom_action')).toBe('auth:custom_action')
  })

  it.concurrent('builds GoTrue ConfirmationURL from token_hash', () => {
    expect(buildAuthConfirmationUrl(
      'https://api.capgo.app/',
      'token-hash',
      'signup',
      'https://console.capgo.app/',
    )).toBe('https://api.capgo.app/auth/v1/verify?token=token-hash&type=signup&redirect_to=https%3A%2F%2Fconsole.capgo.app%2F')
  })

  it.concurrent('sends only GoTrue template fields on the Bento event', () => {
    const details = buildAuthEmailBentoDetails({
      email: ' user@capgo.app ',
      email_action_type: 'email_change',
      factor_type: 'totp',
      new_email: 'new@capgo.app',
      old_email: 'old@capgo.app',
      redirect_to: 'https://console.capgo.app',
      site_url: 'https://ignored.example',
      token: '305805',
      token_hash: 'hash-1',
    }, 'https://xyz.supabase.co', 'https://console.capgo.app/')

    expect(details).toEqual({
      confirmation_url: 'https://xyz.supabase.co/auth/v1/verify?token=hash-1&type=email_change&redirect_to=https%3A%2F%2Fconsole.capgo.app',
      email: 'user@capgo.app',
      factor_type: 'totp',
      new_email: 'new@capgo.app',
      old_email: 'old@capgo.app',
      site_url: 'https://console.capgo.app',
      token: '305805',
    })
    expect(Object.keys(details).sort()).toEqual([
      'confirmation_url',
      'email',
      'factor_type',
      'new_email',
      'old_email',
      'site_url',
      'token',
    ])
  })

  it.concurrent('uses GoTrue site_url when WEBAPP_URL is empty', () => {
    const details = buildAuthEmailBentoDetails({
      email: 'user@capgo.app',
      email_action_type: 'signup',
      site_url: 'https://console.capgo.app/',
      token: '123456',
      token_hash: 'hash-2',
    }, 'https://xyz.supabase.co', '')

    expect(details.site_url).toBe('https://console.capgo.app')
    expect(details.confirmation_url).toContain('/auth/v1/verify?token=hash-2&type=signup')
  })
})
