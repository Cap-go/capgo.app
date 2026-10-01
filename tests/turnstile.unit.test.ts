import { describe, expect, it, vi } from 'vitest'
import { isRecoverableTurnstileError, safeResetTurnstile, shouldRetryTurnstile, TURNSTILE_MAX_RETRIES } from '../src/utils/turnstile.ts'

describe('safeResetTurnstile', () => {
  it('calls reset when the component is present', () => {
    const reset = vi.fn()
    safeResetTurnstile({ reset })
    expect(reset).toHaveBeenCalledOnce()
  })

  it('no-ops when the component ref is null', () => {
    expect(() => safeResetTurnstile(null)).not.toThrow()
  })

  it('swallows Turnstile reset errors when the container is gone', () => {
    const reset = vi.fn(() => {
      throw new Error('[Cloudflare Turnstile] Nothing to reset found for provided container.')
    })

    expect(() => safeResetTurnstile({ reset })).not.toThrow()
    expect(reset).toHaveBeenCalledOnce()
  })
})

describe('isRecoverableTurnstileError', () => {
  it('treats the reported 300010 login failure as recoverable', () => {
    expect(isRecoverableTurnstileError('300010')).toBe(true)
  })

  it('treats other 3xxxxx and 6xxxxx codes as recoverable', () => {
    expect(isRecoverableTurnstileError('300030')).toBe(true)
    expect(isRecoverableTurnstileError('600010')).toBe(true)
  })

  it('treats config and browser codes as not recoverable', () => {
    // 110xxx bad sitekey/domain, 100xxx init, unsupported browser.
    expect(isRecoverableTurnstileError('110200')).toBe(false)
    expect(isRecoverableTurnstileError('100000')).toBe(false)
    expect(isRecoverableTurnstileError('')).toBe(false)
  })
})

describe('shouldRetryTurnstile', () => {
  it('retries a transient error while under the budget', () => {
    expect(shouldRetryTurnstile('300010', 0)).toBe(true)
    expect(shouldRetryTurnstile('300010', TURNSTILE_MAX_RETRIES - 1)).toBe(true)
  })

  it('stops retrying once the budget is spent', () => {
    expect(shouldRetryTurnstile('300010', TURNSTILE_MAX_RETRIES)).toBe(false)
  })

  it('never retries a non-recoverable error', () => {
    expect(shouldRetryTurnstile('110200', 0)).toBe(false)
  })
})
