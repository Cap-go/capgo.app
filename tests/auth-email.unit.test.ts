import { describe, expect, it } from 'vitest'
import {
  authEmailDeliveriesFromGoTrueEvent,
  authEmailPayloadFromGoTrueEvent,
  buildAuthConfirmationUrl,
  buildAuthEmailBentoDetails,
  getAuthEmailBentoEvent,
} from '../supabase/functions/_backend/utils/auth_email.ts'

describe('auth email Bento mapping', () => {
  it.concurrent('maps GoTrue action types to Bento auth_* events', () => {
    expect(getAuthEmailBentoEvent('signup')).toBe('auth_confirmation')
    expect(getAuthEmailBentoEvent('recovery')).toBe('auth_recovery')
    expect(getAuthEmailBentoEvent('magiclink')).toBe('auth_magic_link')
    expect(getAuthEmailBentoEvent('invite')).toBe('auth_invite')
    expect(getAuthEmailBentoEvent('email_change')).toBe('auth_email_change')
    expect(getAuthEmailBentoEvent('email_change_new')).toBe('auth_email_change')
    expect(getAuthEmailBentoEvent('password_changed_notification')).toBe('auth_password_changed_notification')
    expect(getAuthEmailBentoEvent('mfa_factor_enrolled_notification')).toBe('auth_mfa_factor_enrolled_notification')
  })

  it.concurrent('keeps unknown action types instead of dropping the email', () => {
    expect(getAuthEmailBentoEvent('custom_action')).toBe('auth_custom_action')
  })

  it.concurrent('builds GoTrue ConfirmationURL from token_hash', () => {
    expect(buildAuthConfirmationUrl(
      'https://api.capgo.app/',
      'token-hash',
      'signup',
      'https://console.capgo.app/',
    )).toBe('https://api.capgo.app/auth/v1/verify?token=token-hash&type=signup&redirect_to=https%3A%2F%2Fconsole.capgo.app%2F')
  })

  it.concurrent('normalizes email_change_current verify type to email_change', () => {
    expect(buildAuthConfirmationUrl(
      'https://xyz.supabase.co',
      'hash-current',
      'email_change_current',
      'https://console.capgo.app',
    )).toContain('type=email_change')
  })

  it.concurrent('sends GoTrue template fields plus an encoded confirmation link', () => {
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

    expect(details.confirmation_url).toBe('https://xyz.supabase.co/auth/v1/verify?token=hash-1&type=email_change&redirect_to=https%3A%2F%2Fconsole.capgo.app')
    expect(details.confirmation_link).toBe(`https://console.capgo.app/confirm-signup?confirmation_url=${encodeURIComponent(details.confirmation_url)}`)
    expect(details).toMatchObject({
      email: 'user@capgo.app',
      factor_type: 'totp',
      new_email: 'new@capgo.app',
      old_email: 'old@capgo.app',
      site_url: 'https://console.capgo.app',
      token: '305805',
    })
  })

  it.concurrent('sends insecure email change to the new address', () => {
    expect(authEmailPayloadFromGoTrueEvent({
      user: {
        email: 'old@capgo.app',
        new_email: 'new@capgo.app',
      },
      email_data: {
        email_action_type: 'email_change',
        token: '305805',
        token_hash: 'hash-3',
      },
    })).toMatchObject({
      email: 'new@capgo.app',
      email_action_type: 'email_change',
      new_email: 'new@capgo.app',
      token: '305805',
      token_hash: 'hash-3',
    })
  })

  it.concurrent('splits secure email change into current and new deliveries', () => {
    expect(authEmailDeliveriesFromGoTrueEvent({
      user: {
        email: 'old@capgo.app',
        new_email: 'new@capgo.app',
      },
      email_data: {
        email_action_type: 'email_change',
        token: '111111',
        token_hash: 'hash-new',
        token_new: '222222',
        token_hash_new: 'hash-current',
      },
    })).toEqual([
      {
        email: 'old@capgo.app',
        payload: expect.objectContaining({
          email: 'old@capgo.app',
          token: '111111',
          token_hash: 'hash-current',
        }),
      },
      {
        email: 'new@capgo.app',
        payload: expect.objectContaining({
          email: 'new@capgo.app',
          token: '222222',
          token_hash: 'hash-new',
        }),
      },
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
    expect(details.confirmation_link).toContain('confirmation_url=')
  })
})
