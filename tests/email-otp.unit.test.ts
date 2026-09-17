import { describe, expect, it } from 'vitest'
import {
  getEmailOtpSendErrorMessage,
  parseEmailOtpSendError,
} from '../src/services/emailOtp.ts'

const t = (key: string, params?: Record<string, unknown>) => {
  if (params?.seconds !== undefined)
    return `${key}:${params.seconds}`
  return key
}

describe('parseEmailOtpSendError', () => {
  it('detects rate limit with wait seconds from GoTrue message', () => {
    expect(parseEmailOtpSendError({
      code: 'over_email_send_rate_limit',
      message: 'For security purposes, you can only request this after 54 seconds.',
      status: 429,
    })).toEqual({
      kind: 'rate_limit',
      waitSeconds: 54,
    })
  })

  it('detects rate limit without parsed seconds', () => {
    expect(parseEmailOtpSendError({
      code: 'over_email_send_rate_limit',
      message: 'Too many requests',
      status: 429,
    })).toEqual({
      kind: 'rate_limit',
      waitSeconds: undefined,
    })
  })

  it('detects captcha failures from code or message', () => {
    expect(parseEmailOtpSendError({
      code: 'captcha_failed',
      message: 'Captcha verification failed',
      status: 400,
    })).toEqual({ kind: 'captcha' })

    expect(parseEmailOtpSendError({
      code: 'unexpected_failure',
      message: 'captcha protection: request disallowed (no captcha_token found)',
      status: 400,
    })).toEqual({ kind: 'captcha' })
  })

  it('falls back to generic send failures', () => {
    expect(parseEmailOtpSendError({
      code: 'unexpected_failure',
      message: 'Something went wrong',
      status: 500,
    })).toEqual({ kind: 'generic' })
  })

  it('returns null for missing errors', () => {
    expect(parseEmailOtpSendError(null)).toBeNull()
  })
})

describe('getEmailOtpSendErrorMessage', () => {
  it('maps parsed errors to i18n keys', () => {
    expect(getEmailOtpSendErrorMessage({ kind: 'rate_limit', waitSeconds: 30 }, t))
      .toBe('email-otp-rate-limit-wait:30')
    expect(getEmailOtpSendErrorMessage({ kind: 'rate_limit' }, t))
      .toBe('email-otp-rate-limit-wait-unknown')
    expect(getEmailOtpSendErrorMessage({ kind: 'captcha' }, t))
      .toBe('captcha-fail')
    expect(getEmailOtpSendErrorMessage({ kind: 'generic' }, t))
      .toBe('email-otp-send-failed')
  })
})
