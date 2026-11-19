export type ConsoleCaptchaStatus = 'disabled' | 'loading' | 'ready' | 'unavailable'

export const CONSOLE_CAPTCHA_INIT_TIMEOUT_MS = 25_000
export const CONSOLE_CAPTCHA_TOKEN_WAIT_MS = 30_000

export function shouldBlockConsoleCaptchaSubmit(
  captchaKey: string | undefined,
  status: ConsoleCaptchaStatus,
  token: string,
): boolean {
  if (!captchaKey)
    return false
  if (status === 'unavailable')
    return false
  return status === 'loading' || !token
}

export function isConsoleCaptchaFallbackActive(
  captchaKey: string | undefined,
  status: ConsoleCaptchaStatus,
): boolean {
  return !!captchaKey && status === 'unavailable'
}

export function waitForTurnstileToken(
  getToken: () => string,
  timeoutMs = CONSOLE_CAPTCHA_TOKEN_WAIT_MS,
): Promise<string> {
  const existing = getToken().trim()
  if (existing)
    return Promise.resolve(existing)

  return new Promise((resolve, reject) => {
    const started = Date.now()
    const interval = globalThis.setInterval(() => {
      const token = getToken().trim()
      if (token) {
        globalThis.clearInterval(interval)
        resolve(token)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        globalThis.clearInterval(interval)
        reject(new Error('turnstile_token_timeout'))
      }
    }, 50)
  })
}
