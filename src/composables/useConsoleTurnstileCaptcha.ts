import type { Ref } from 'vue'
import type { ConsoleCaptchaStatus } from '~/utils/consoleTurnstileCaptcha'
import type { TurnstileComponentRef } from '~/utils/turnstile'
import { onBeforeUnmount, ref, watch } from 'vue'
import {
  CONSOLE_CAPTCHA_INIT_TIMEOUT_MS,
  isConsoleCaptchaFallbackActive,
  shouldBlockConsoleCaptchaSubmit,
} from '~/utils/consoleTurnstileCaptcha'
import { safeResetTurnstile } from '~/utils/turnstile'

export function useConsoleTurnstileCaptcha(captchaKey: Ref<string | undefined>, options?: { enabled?: () => boolean }) {
  const turnstileToken = ref('')
  const captchaComponent = ref<TurnstileComponentRef>(null)
  const captchaStatus = ref<ConsoleCaptchaStatus>(captchaKey.value ? 'loading' : 'disabled')
  let captchaInitTimeout: ReturnType<typeof setTimeout> | null = null

  function isStepEnabled() {
    return options?.enabled?.() ?? true
  }

  function clearCaptchaInitTimeout() {
    if (captchaInitTimeout) {
      clearTimeout(captchaInitTimeout)
      captchaInitTimeout = null
    }
  }

  function scheduleCaptchaInitTimeout() {
    if (!captchaKey.value || !isStepEnabled()) {
      clearCaptchaInitTimeout()
      return
    }

    clearCaptchaInitTimeout()
    captchaInitTimeout = setTimeout(() => {
      if (!turnstileToken.value && !(globalThis as typeof globalThis & { turnstile?: unknown }).turnstile) {
        captchaStatus.value = 'unavailable'
        console.error('Turnstile failed to initialize')
      }
    }, CONSOLE_CAPTCHA_INIT_TIMEOUT_MS)
  }

  function handleCaptchaUnavailable(reason: string, error?: unknown) {
    captchaStatus.value = 'unavailable'
    clearCaptchaInitTimeout()
    console.error(reason, error)
  }

  function resetCaptchaWidget() {
    turnstileToken.value = ''
    safeResetTurnstile(captchaComponent.value)
    if (captchaKey.value && captchaStatus.value !== 'unavailable') {
      captchaStatus.value = 'loading'
      scheduleCaptchaInitTimeout()
    }
  }

  watch(turnstileToken, (token) => {
    if (!captchaKey.value) {
      captchaStatus.value = 'disabled'
      return
    }

    if (token) {
      captchaStatus.value = 'ready'
      clearCaptchaInitTimeout()
    }
    else if (isStepEnabled() && captchaStatus.value !== 'unavailable') {
      captchaStatus.value = 'loading'
      scheduleCaptchaInitTimeout()
    }
  })

  watch(captchaKey, (key) => {
    if (!key) {
      captchaStatus.value = 'disabled'
      clearCaptchaInitTimeout()
    }
    else if (isStepEnabled()) {
      captchaStatus.value = turnstileToken.value ? 'ready' : 'loading'
      scheduleCaptchaInitTimeout()
    }
  }, { immediate: true })

  onBeforeUnmount(() => {
    clearCaptchaInitTimeout()
  })

  const shouldBlockForCaptcha = () => shouldBlockConsoleCaptchaSubmit(captchaKey.value, captchaStatus.value, turnstileToken.value)
  const useCaptchaFallback = () => isConsoleCaptchaFallbackActive(captchaKey.value, captchaStatus.value)

  return {
    turnstileToken,
    captchaComponent,
    captchaStatus,
    shouldBlockForCaptcha,
    useCaptchaFallback,
    handleCaptchaUnavailable,
    resetCaptchaWidget,
    scheduleCaptchaInitTimeout,
    clearCaptchaInitTimeout,
  }
}
