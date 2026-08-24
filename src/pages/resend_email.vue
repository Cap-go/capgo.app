<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import iconEmail from '~icons/oui/email?raw'
import { authGhostButtonClass, authInsetCardClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import { getRecentEmailOtpVerification, sendEmailOtpVerification, verifyEmailOtp } from '~/services/emailOtp'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { useMainStore } from '~/stores/main'
import { safeResetTurnstile } from '~/utils/turnstile'

const { t } = useI18n()
const supabase = useSupabase()
const route = useRoute()
const router = useRouter()
const main = useMainStore()
const isLoading = ref(false)
const isLoadingMain = ref(false)
const otpSending = ref(false)
const otpCaptchaToken = ref('')
const otpCaptchaRef = ref<InstanceType<typeof VueTurnstile> | null>(null)
const otpVerificationCode = ref('')
const otpVerificationLoading = ref(false)
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const currentUserId = ref('')
const currentUserEmail = ref('')
const emailVerificationBlockingReason = computed(() => route.query.reason === 'email_not_verified')
const returnTo = computed(() => (typeof route.query.return_to === 'string' ? route.query.return_to : ''))
const usesEmailOtpFlow = computed(() => emailVerificationBlockingReason.value && !!currentUserId.value && !!currentUserEmail.value)

async function submit(form: { email: string }) {
  isLoading.value = true
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: form.email,
  })
  isLoading.value = false
  if (error)
    setErrors('resend-email', [error.message], {})
  else toast.success(t('confirm-email-sent'))
}

async function loadDeleteEmailVerificationState() {
  if (!emailVerificationBlockingReason.value)
    return

  isLoadingMain.value = true
  try {
    await main.awaitInitialLoad()
    const { data: sessionData } = await supabase.auth.getSession()
    currentUserId.value = sessionData.session?.user.id ?? main.auth?.id ?? ''
    currentUserEmail.value = sessionData.session?.user.email ?? main.auth?.email ?? main.user?.email ?? ''

    if (!currentUserId.value)
      return

    const { isVerified } = await getRecentEmailOtpVerification(supabase, currentUserId.value)
    if (isVerified)
      await router.replace(returnTo.value || '/settings/account')
  }
  catch (error) {
    console.error('Cannot load email verification state', error)
  }
  finally {
    isLoadingMain.value = false
  }
}

async function sendOtpCode() {
  if (!currentUserEmail.value || otpSending.value)
    return

  if (captchaKey.value && !otpCaptchaToken.value) {
    toast.error(t('captcha-required'))
    return
  }

  otpSending.value = true
  const { error } = await sendEmailOtpVerification(supabase, currentUserEmail.value, otpCaptchaToken.value)
  otpSending.value = false
  otpCaptchaToken.value = ''
  safeResetTurnstile(otpCaptchaRef.value)

  if (error) {
    toast.error(error.message.toLowerCase().includes('captcha') ? t('captcha-fail') : t('verification-failed'))
    console.error('Cannot send email OTP', error)
    return
  }

  toast.success(t('email-otp-sent'))
}

async function verifyOtpCode() {
  const token = otpVerificationCode.value.replaceAll(' ', '')
  if (!token) {
    toast.error(t('email-otp-code-required'))
    return
  }
  if (otpVerificationLoading.value)
    return

  otpVerificationLoading.value = true
  const { data, error } = await verifyEmailOtp(supabase, token)
  otpVerificationLoading.value = false

  if (error || !data?.verified_at) {
    toast.error(t('verification-failed'))
    console.error('Cannot verify email OTP', error)
    return
  }

  await router.replace(returnTo.value || '/settings/account')
}

onMounted(async () => {
  await loadDeleteEmailVerificationState()
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    :card-kicker="t('resend')"
    :card-title="t('resend-email')"
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
        <p v-if="returnTo" class="mt-3 text-xs font-medium tracking-[0.12em] uppercase">
          {{ t('attempted-destination') }} {{ returnTo }}
        </p>
      </div>

      <div v-if="usesEmailOtpFlow" class="space-y-5 text-slate-500 dark:text-slate-300">
        <div :class="authInsetCardClass">
          <p class="mb-1 font-medium text-slate-700 dark:text-slate-100">
            {{ currentUserEmail }}
          </p>
          <p class="text-xs leading-5">
            {{ t('email-otp-code-required') }}
          </p>
        </div>

        <div v-if="captchaKey" class="space-y-2">
          <p class="text-sm font-medium text-slate-700 dark:text-slate-100">
            {{ t('captcha') }}
          </p>
          <VueTurnstile
            ref="otpCaptchaRef"
            v-model="otpCaptchaToken"
            size="flexible"
            :site-key="captchaKey"
          />
        </div>

        <button
          type="button"
          :class="authPrimaryButtonClass"
          :disabled="otpSending || otpVerificationLoading"
          :aria-busy="otpSending ? 'true' : 'false'"
          @click="sendOtpCode"
        >
          <svg v-if="otpSending" class="inline-block mr-1 h-5 w-5 animate-spin align-middle text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          {{ t('email-otp-send-code') }}
        </button>

        <FormKit
          v-model="otpVerificationCode"
          type="text"
          name="email_otp"
          :label="t('email-otp-code-required')"
          inputmode="numeric"
          autocomplete="one-time-code"
          validation="required:trim|length:6"
        />

        <button
          type="button"
          :class="authPrimaryButtonClass"
          :disabled="otpVerificationLoading || otpSending"
          :aria-busy="otpVerificationLoading ? 'true' : 'false'"
          @click="verifyOtpCode"
        >
          <svg v-if="otpVerificationLoading" class="inline-block mr-1 h-5 w-5 animate-spin align-middle text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          {{ t('validate-email') }}
        </button>

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
