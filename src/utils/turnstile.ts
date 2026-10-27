/** ~/components/VueTurnstile.vue instance ref shape — only reset() is needed for safe cleanup. */
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

export interface TurnstileRenderOptions {
  'sitekey': string
  'theme': string
  'language': string
  'size': string
  'action': string
  'appearance': string
  'callback': (token: string) => void
  'error-callback': (error: unknown) => void
  'expired-callback': () => void
  'unsupported-callback': () => void
  'before-interactive-callback': () => void
  'after-interactive-callback': () => void
}

interface TurnstileApi {
  render: (element: HTMLElement, options: TurnstileRenderOptions) => string
  reset: (widgetId?: string) => void
  remove: (widgetId: string) => void
}

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
const ONLOAD_CALLBACK_NAME = 'cfTurnstileOnLoad'

/** The Cloudflare Turnstile global, once its script has loaded. */
export function turnstileApi() {
  return typeof window === 'undefined' ? undefined : (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

// Shared across every widget instance: the Cloudflare script is injected once.
let scriptState: 'unloaded' | 'loading' | 'ready' = turnstileApi() ? 'ready' : 'unloaded'
let scriptLoad: Promise<void> | undefined

/** Injects the Cloudflare script once and resolves when it is ready; shared by every widget. */
export function loadTurnstileScript(): Promise<void> {
  if (scriptState === 'ready')
    return Promise.resolve()
  if (scriptLoad)
    return scriptLoad

  scriptLoad = new Promise<void>((resolve, reject) => {
    (window as unknown as Record<string, () => void>)[ONLOAD_CALLBACK_NAME] = () => {
      scriptState = 'ready'
      resolve()
    }
    scriptState = 'loading'
    const script = document.createElement('script')
    script.src = `${TURNSTILE_SCRIPT_URL}?onload=${ONLOAD_CALLBACK_NAME}&render=explicit`
    script.async = true
    script.addEventListener('error', () => {
      scriptLoad = undefined
      scriptState = 'unloaded'
      reject(new Error('Failed to load Turnstile.'))
    })
    document.head.appendChild(script)
  })
  return scriptLoad
}
