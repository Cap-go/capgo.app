<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import iconEmail from '~icons/oui/email?raw'
import { authGhostButtonClass, authInsetCardClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import { getEmailOtpSendErrorMessage, getRecentEmailOtpVerification, parseEmailOtpSendError, sendEmailOtpVerification, verifyEmailOtp } from '~/services/emailOtp'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { useMainStore } from '~/stores/main'
import { validateRedirectPath } from '~/utils/safeRedirect'
import { safeResetTurnstile } from '~/utils/turnstile'

const { t } = useI18n()
const supabase = useSupabase()
const route = useRoute()
const router = useRouter()
const main = useMainStore()
const isLoading = ref(false)
const resendCaptchaToken = ref('')
const resendCaptchaRef = ref<InstanceType<typeof VueTurnstile> | null>(null)
const resendCaptchaStatus = ref<'disabled' | 'loading' | 'ready' | 'unavailable'>(import.meta.env.VITE_CAPTCHA_KEY ? 'loading' : 'disabled')
let resendCaptchaInitTimeout: ReturnType<typeof setTimeout> | null = null
const isLoadingMain = ref(route.query.reason === 'email_not_verified')
const otpStep = ref<'send' | 'verify'>('send')
const otpHasSentCode = ref(false)
const otpSending = ref(false)
const otpSendError = ref('')
const otpSendCooldownSeconds = ref(0)
const otpCaptchaToken = ref('')
const otpCaptchaRef = ref<InstanceType<typeof VueTurnstile> | null>(null)
const otpVerificationCode = ref('')
const otpVerificationLoading = ref(false)
let otpSendCooldownTimer: ReturnType<typeof setInterval> | null = null
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const currentUserId = ref('')
const currentUserEmail = ref('')
const emailVerificationBlockingReason = computed(() => route.query.reason === 'email_not_verified')
const rawReturnToQuery = computed(() => typeof route.query.return_to === 'string' ? route.query.return_to : '')
const returnTo = computed(() => validateRedirectPath(rawReturnToQuery.value, '/settings/account'))
const attemptedDestination = computed(() => validateRedirectPath(rawReturnToQuery.value, rawReturnToQuery.value))
const usesEmailOtpFlow = computed(() => emailVerificationBlockingReason.value && !!currentUserId.value && !!currentUserEmail.value)
const otpSendDisabled = computed(() => otpSending.value || otpSendCooldownSeconds.value > 0 || (!!captchaKey.value && !otpCaptchaToken.value))
const shouldBlockForResendCaptcha = computed(() => !!captchaKey.value && resendCaptchaStatus.value === 'loading' && !resendCaptchaToken.value)

watch(otpStep, async (step) => {
  if (step === 'send') {
    otpCaptchaToken.value = ''
    otpSendError.value = ''
    return
  }
  await nextTick()
  document.getElementById('email-verification-code')?.focus()
})

function clearResendCaptchaInitTimeout() {
  if (resendCaptchaInitTimeout) {
    clearTimeout(resendCaptchaInitTimeout)
    resendCaptchaInitTimeout = null
  }
}

function handleResendCaptchaUnavailable() {
  resendCaptchaToken.value = ''
  resendCaptchaStatus.value = 'unavailable'
  clearResendCaptchaInitTimeout()
}

function scheduleResendCaptchaInitTimeout() {
  clearResendCaptchaInitTimeout()
  if (!captchaKey.value || !resendCaptchaRef.value || resendCaptchaToken.value || resendCaptchaStatus.value === 'unavailable')
    return

  resendCaptchaInitTimeout = setTimeout(() => {
    if (!resendCaptchaToken.value && !(globalThis as typeof globalThis & { turnstile?: unknown }).turnstile)
      handleResendCaptchaUnavailable()
  }, 8000)
}

watch(resendCaptchaRef, scheduleResendCaptchaInitTimeout)
watch(resendCaptchaToken, (token) => {
  if (token) {
    resendCaptchaStatus.value = 'ready'
    clearResendCaptchaInitTimeout()
  }
  else if (resendCaptchaStatus.value !== 'unavailable' && captchaKey.value) {
    resendCaptchaStatus.value = 'loading'
    scheduleResendCaptchaInitTimeout()
  }
}, { flush: 'sync' })

function showResendError(message: string) {
  setErrors('resend-email', [message], {})
  toast.error(message)
}

function clearOtpSendCooldownTimer() {
  if (otpSendCooldownTimer) {
    clearInterval(otpSendCooldownTimer)
    otpSendCooldownTimer = null
  }
}

function resetOtpCaptcha() {
  otpCaptchaToken.value = ''
  safeResetTurnstile(otpCaptchaRef.value)
}

function startOtpSendCooldown(seconds: number) {
  clearOtpSendCooldownTimer()
  otpSendCooldownSeconds.value = seconds
  otpSendCooldownTimer = setInterval(() => {
    if (otpSendCooldownSeconds.value <= 1) {
      otpSendCooldownSeconds.value = 0
      clearOtpSendCooldownTimer()
      resetOtpCaptcha()
      otpSendError.value = ''
    }
    else {
      otpSendCooldownSeconds.value -= 1
    }
  }, 1000)
}

async function submit(form: { email: string }) {
  if (isLoading.value)
    return

  if (shouldBlockForResendCaptcha.value) {
    setErrors('resend-email', [t('captcha-required')], {})
    return
  }

  isLoading.value = true
  try {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: form.email,
      options: { captchaToken: resendCaptchaToken.value || undefined },
    })
    if (error)
      showResendError(error.message)
    else toast.success(t('confirm-email-sent'))
  }
  catch (error) {
    showResendError(error instanceof Error && error.message ? error.message : t('confirm-email-send-failed'))
  }
  finally {
    isLoading.value = false
    resendCaptchaToken.value = ''
    safeResetTurnstile(resendCaptchaRef.value)
  }
}

async function loadEmailVerificationState() {
  if (!emailVerificationBlockingReason.value)
    return

  isLoadingMain.value = true
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    currentUserId.value = sessionData.session?.user.id ?? main.auth?.id ?? ''
    currentUserEmail.value = sessionData.session?.user.email ?? main.auth?.email ?? main.user?.email ?? ''

    if (!currentUserId.value)
      return

    const { isVerified } = await getRecentEmailOtpVerification(supabase, currentUserId.value)
    if (isVerified)
      await router.replace(returnTo.value)
  }
  catch (error) {
    console.error('Cannot load email verification state', error)
  }
  finally {
    isLoadingMain.value = false
  }
}

async function sendOtpCode() {
  if (!currentUserEmail.value || otpSending.value || otpSendCooldownSeconds.value > 0)
    return

  if (captchaKey.value && !otpCaptchaToken.value) {
    const message = t('captcha-required')
    otpSendError.value = message
    toast.error(message)
    return
  }

  otpSending.value = true
  otpSendError.value = ''
  try {
    const { error } = await sendEmailOtpVerification(supabase, currentUserEmail.value, otpCaptchaToken.value)
    if (error) {
      const parsed = parseEmailOtpSendError(error)
      const message = parsed
        ? getEmailOtpSendErrorMessage(parsed, t)
        : t('email-otp-send-failed')
      otpSendError.value = message
      toast.error(message)
      console.error('Cannot send email OTP', error)

      if (parsed?.kind === 'rate_limit')
        startOtpSendCooldown(parsed.waitSeconds ?? 60)

      return
    }

    otpHasSentCode.value = true
    otpVerificationCode.value = ''
    otpStep.value = 'verify'
    toast.success(t('email-otp-sent'))
  }
  catch (error) {
    otpSendError.value = t('email-otp-send-failed')
    toast.error(otpSendError.value)
    console.error('Cannot send email OTP', error)
    return
  }
  finally {
    otpSending.value = false
    resetOtpCaptcha()
  }
}

async function verifyOtpCode(form: { email_otp: string }) {
  if (otpStep.value !== 'verify')
    return

  const token = form.email_otp.replaceAll(' ', '')
  if (!token) {
    toast.error(t('email-otp-code-required'))
    return
  }
  if (otpVerificationLoading.value)
    return

  otpVerificationLoading.value = true
  try {
    const { data, error } = await verifyEmailOtp(supabase, token)

    if (error || !data?.verified_at) {
      toast.error(t('verification-failed'))
      console.error('Cannot verify email OTP', error)
      return
    }

    await router.replace(returnTo.value || '/settings/account')
  }
  catch (error) {
    toast.error(t('verification-failed'))
    console.error('Cannot verify email OTP', error)
  }
  finally {
    otpVerificationLoading.value = false
  }
}

onMounted(async () => {
  await loadEmailVerificationState()
})

onBeforeUnmount(() => {
  clearResendCaptchaInitTimeout()
  clearOtpSendCooldownTimer()
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    :card-kicker="emailVerificationBlockingReason ? t('email') : t('resend')"
    :card-title="emailVerificationBlockingReason ? t('email-verification-title') : t('resend-email')"
  >
    <div v-if="isLoadingMain" class="flex justify-center py-10">
      <Spinner size="w-14 h-14" class="my-auto" />
    </div>

    <template v-else>
      <div
        v-if="emailVerificationBlockingReason"
        class="mb-5 overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/90 p-3 text-amber-900 dark:border-amber-700/70 dark:bg-amber-900/25 dark:text-amber-100"
      >
        <p class="font-semibold">
          {{ t('email-not-verified-banner-title') }}
        </p>
        <p class="mt-2 text-sm leading-6">
          {{ t('email-not-verified-banner-body') }}
        </p>
        <p v-if="rawReturnToQuery" class="mt-3 text-xs font-medium tracking-[0.12em] uppercase">
          {{ t('attempted-destination') }} {{ attemptedDestination }}
        </p>
      </div>

      <div v-if="usesEmailOtpFlow" class="space-y-5 text-slate-500 dark:text-slate-300">
        <div :class="authInsetCardClass">
          <p class="mb-1 font-medium text-slate-700 dark:text-slate-100">
            {{ currentUserEmail }}
          </p>
          <p class="text-xs leading-5" :role="otpStep === 'verify' ? 'status' : undefined">
            {{ otpStep === 'verify' ? t('email-otp-enter-description') : t('email-otp-send-description') }}
          </p>
        </div>

        <template v-if="otpStep === 'send'">
          <div v-if="captchaKey" class="space-y-2">
            <p class="text-sm font-medium text-slate-700 dark:text-slate-100">
              {{ t('captcha') }}
            </p>
            <VueTurnstile
              ref="otpCaptchaRef"
              v-model="otpCaptchaToken"
              size="flexible"
              :site-key="captchaKey"
              @expired="otpCaptchaToken = ''"
            />
          </div>

          <p
            v-if="otpSendError"
            class="text-sm text-red-600 dark:text-red-400"
            role="alert"
          >
            {{ otpSendError }}
          </p>
          <p
            v-if="otpSendCooldownSeconds > 0"
            class="text-sm text-amber-700 dark:text-amber-300"
            role="status"
          >
            {{ t('email-otp-rate-limit-countdown', { seconds: otpSendCooldownSeconds }) }}
          </p>

          <button
            type="button"
            :class="authPrimaryButtonClass"
            :disabled="otpSendDisabled || otpVerificationLoading"
            :aria-busy="otpSending ? 'true' : 'false'"
            @click="sendOtpCode"
          >
            <svg v-if="otpSending" class="inline-block mr-1 h-5 w-5 animate-spin align-middle text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {{
              otpSendCooldownSeconds > 0
                ? t('email-otp-send-wait', { seconds: otpSendCooldownSeconds })
                : t('email-otp-send-code')
            }}
          </button>

          <button
            v-if="otpHasSentCode"
            type="button"
            :class="authGhostButtonClass"
            :disabled="otpSending"
            @click="otpStep = 'verify'"
          >
            {{ t('email-otp-back-to-code') }}
          </button>
        </template>

        <FormKit v-if="otpHasSentCode" v-show="otpStep === 'verify'" id="verify-email-otp" type="form" :actions="false" @submit="verifyOtpCode">
          <div class="space-y-5">
            <FormKit
              id="email-verification-code"
              v-model="otpVerificationCode"
              type="text"
              name="email_otp"
              :label="t('email-otp-code-required')"
              :disabled="otpVerificationLoading"
              inputmode="numeric"
              autocomplete="one-time-code"
              validation="required:trim|length:6"
            />

            <button
              type="submit"
              :class="authPrimaryButtonClass"
              :disabled="otpVerificationLoading || otpSending"
              :aria-busy="otpVerificationLoading ? 'true' : 'false'"
            >
              <svg v-if="otpVerificationLoading" class="inline-block mr-1 h-5 w-5 animate-spin align-middle text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              {{ t('validate-email') }}
            </button>

            <button
              type="button"
              :class="authGhostButtonClass"
              :disabled="otpVerificationLoading"
              @click="otpStep = 'send'"
            >
              {{ t('email-otp-resend-code') }}
            </button>
          </div>
        </FormKit>

        <div :class="authPanelClass">
          <router-link to="/login" class="text-sm font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]">
            {{ t('back-to-login-page') }}
          </router-link>
        </div>
      </div>

      <FormKit v-else id="resend-email" type="form" :actions="false" @submit="submit">
        <div class="space-y-5 text-slate-500 dark:text-slate-300">
          <FormKit
            type="email"
            name="email"
            :label="t('email')"
            :disabled="isLoading"
            :prefix-icon="iconEmail"
            inputmode="email"
            autocomplete="email"
            validation="required:trim"
          />

          <div v-if="captchaKey" class="space-y-2">
            <p class="text-sm font-medium text-slate-700 dark:text-slate-100">
              {{ t('captcha') }}
            </p>
            <VueTurnstile
              ref="resendCaptchaRef"
              v-model="resendCaptchaToken"
              size="flexible"
              :site-key="captchaKey"
              @error="handleResendCaptchaUnavailable"
              @unsupported="handleResendCaptchaUnavailable"
              @expired="resendCaptchaToken = ''"
            />
            <p v-if="resendCaptchaStatus === 'unavailable'" class="text-xs leading-5 text-amber-700 dark:text-amber-300" role="status">
              {{ t('captcha-resend-unavailable') }}
            </p>
          </div>

          <FormKitMessages />

          <div>
            <button type="submit" :disabled="isLoading" :aria-busy="isLoading ? 'true' : 'false'" :class="authPrimaryButtonClass">
              <svg v-if="isLoading" class="inline-block mr-1 h-5 w-5 animate-spin align-middle text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle
                  class="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  stroke-width="4"
                />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              {{ t('resend') }}
            </button>
          </div>

          <div :class="authPanelClass">
            <router-link to="/login" class="text-sm font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]">
              {{ t('back-to-login-page') }}
            </router-link>
          </div>
        </div>
      </FormKit>
    </template>

    <template #footer>
      <section class="mt-6 flex flex-col items-center">
        <div class="mx-auto">
          <LangSelector />
        </div>
        <button type="button" class="mt-3" :class="authGhostButtonClass" @click="openSupport">
          {{ t('support') }}
        </button>
      </section>
    </template>
  </AuthPageShell>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
