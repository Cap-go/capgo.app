/** VueTurnstile instance ref shape — only reset() is needed for safe cleanup. */
export type TurnstileComponentRef = { reset?: () => void } | null | undefined

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
