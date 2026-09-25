/** VueTurnstile instance ref shape — only reset() is needed for safe cleanup. */
export type TurnstileComponentRef = { reset?: () => void } | null | undefined

/** Reset attempts allowed before we declare Turnstile unavailable. */
export const TURNSTILE_MAX_RETRIES = 2

/**
 * Reset a Cloudflare Turnstile widget without throwing when the container
 * was destroyed (v-if step change, remount, or failed init).
 */
export function safeResetTurnstile(component: TurnstileComponentRef): void {
  if (!component?.reset)
    return

  try {
    component.reset()
  }
  catch {
    // Cloudflare Turnstile throws TurnstileError when nothing to reset.
  }
}

/**
 * Report whether a Turnstile error code clears after a widget reset.
 *
 * The 3xxxxx (generic client execution) and 6xxxxx (challenge / timeout)
 * families are transient — a slow network, a WebView, or an ad-blocker — and a
 * reset lets the challenge run again. Other families (bad sitekey, unsupported
 * browser, wrong domain) do not clear on retry.
 * See https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
 */
export function isRecoverableTurnstileError(code: string): boolean {
  return /^[36]\d+$/.test(code)
}

/**
 * Decide whether to reset and retry the widget after a Turnstile error. Retry
 * only transient errors, and only while under the retry budget.
 */
export function shouldRetryTurnstile(code: string, retries: number, maxRetries: number = TURNSTILE_MAX_RETRIES): boolean {
  return isRecoverableTurnstileError(code) && retries < maxRetries
}
