import { describe, expect, it, vi } from 'vitest'
import {
  CONSOLE_CAPTCHA_INIT_TIMEOUT_MS,
  isConsoleCaptchaFallbackActive,
  shouldBlockConsoleCaptchaSubmit,
  waitForTurnstileToken,
} from '../src/utils/consoleTurnstileCaptcha'

describe('consoleTurnstileCaptcha', () => {
  it('blocks submit while captcha is loading or token is empty', () => {
    expect(shouldBlockConsoleCaptchaSubmit('site-key', 'loading', '')).toBe(true)
    expect(shouldBlockConsoleCaptchaSubmit('site-key', 'ready', '')).toBe(true)
    expect(shouldBlockConsoleCaptchaSubmit('site-key', 'ready', 'token')).toBe(false)
    expect(shouldBlockConsoleCaptchaSubmit(undefined, 'loading', '')).toBe(false)
  })

  it('enables fallback UI when captcha is unavailable', () => {
    expect(isConsoleCaptchaFallbackActive('site-key', 'unavailable')).toBe(true)
    expect(isConsoleCaptchaFallbackActive('site-key', 'loading')).toBe(false)
    expect(isConsoleCaptchaFallbackActive(undefined, 'unavailable')).toBe(false)
  })

  it('uses a sane init timeout budget', () => {
    expect(CONSOLE_CAPTCHA_INIT_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000)
    expect(CONSOLE_CAPTCHA_INIT_TIMEOUT_MS).toBeLessThanOrEqual(35_000)
  })

  it('waits for a token then resolves', async () => {
    vi.useFakeTimers()
    let token = ''
    const pending = waitForTurnstileToken(() => token, 1000)
    vi.advanceTimersByTimeAsync(100)
    token = 'fresh-token'
    vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe('fresh-token')
    vi.useRealTimers()
  })
})
