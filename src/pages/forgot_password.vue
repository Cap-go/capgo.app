<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import iconEmail from '~icons/oui/email?raw'
import iconPassword from '~icons/ph/key?raw'
import { authGhostButtonClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { useDialogV2Store } from '~/stores/dialogv2'

const { t } = useI18n()
const router = useRouter()
const route = useRoute('/forgot_password')
const supabase = useSupabase()
const dialogStore = useDialogV2Store()
const step = ref(1)
const turnstileToken = ref('')
const mfaCode = ref('')

const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)

const isLoading = ref(false)
const isLoadingMain = ref(true)
const initialEmail = ref('')
const initialFormValue = computed(() => ({ email: initialEmail.value }))
const cardDescription = computed(() => step.value === 1 ? t('enter-your-email-add') : t('enter-your-new-passw'))

if (typeof history !== 'undefined') {
  const currentHistoryState = history.state as Record<string, unknown> | null
  if (typeof currentHistoryState?.resetEmail === 'string') {
    initialEmail.value = currentHistoryState.resetEmail
    const nextHistoryState = { ...currentHistoryState }
    delete nextHistoryState.resetEmail
    history.replaceState(nextHistoryState, '')
  }
}

function getRecoveryParams() {
  const hashParams = new URLSearchParams(route.hash.replace('#', ''))
  const queryParams = new URLSearchParams(window.location.search)
  return {
    accessToken: hashParams.get('access_token') ?? queryParams.get('access_token') ?? '',
    refreshToken: hashParams.get('refresh_token') ?? queryParams.get('refresh_token') ?? '',
    code: queryParams.get('code') ?? hashParams.get('code') ?? '',
    error: queryParams.get('error') ?? hashParams.get('error') ?? '',
    errorDescription: queryParams.get('error_description') ?? hashParams.get('error_description') ?? '',
  }
}

function finishWithError(message: string, error?: unknown) {
  setErrors('forgot-password', [message], {})
  if (error)
    console.error('forgot password error', error)
  isLoading.value = false
}

async function step1(form: { email: string }) {
  const redirectTo = `${import.meta.env.VITE_APP_URL}/forgot_password?step=2`
  // console.log('redirect', redirectTo)
  const { error } = await supabase.auth.resetPasswordForEmail(form.email, { redirectTo, captchaToken: turnstileToken.value })
  if (error) {
    if (error.message.includes('captcha')) {
      toast.error(t('captcha-fail'))
    }
    setErrors('forgot-password', [error.message], {})
    console.error('error reset', error)
  }
  else {
    toast.success(t('forgot-check-email'))
  }
  isLoading.value = false
}

async function step2(form: { password: string, password_confirm: string }) {
  const { accessToken, refreshToken, code, error, errorDescription } = getRecoveryParams()
  if (error) {
    finishWithError(errorDescription || error)
    return
  }
  if (accessToken && refreshToken) {
    const { error: sessionError } = await supabase.auth.setSession({ refresh_token: refreshToken, access_token: accessToken })
    if (sessionError) {
      finishWithError(sessionError.message, sessionError)
      return
    }
  }
  else if (code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    if (exchangeError) {
      finishWithError(exchangeError.message, exchangeError)
      return
    }
  }
  else {
    finishWithError(t('expired'))
    return
  }
  const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const { currentLevel, nextLevel } = aal.data!
  if (nextLevel !== currentLevel) {
    const { data: mfaFactors, error: mfaError } = await supabase.auth.mfa.listFactors()
    if (mfaError) {
      finishWithError(mfaError.message, mfaError)
      return
    }
    const factor = mfaFactors.all.find(factor => factor.status === 'verified')
    if (!factor) {
      finishWithError('Cannot find MFA factor')
      return
    }

    const { data: challenge, error: errorChallenge } = await supabase.auth.mfa.challenge({ factorId: factor.id })
    if (errorChallenge) {
      finishWithError(errorChallenge.message, errorChallenge)
      return
    }

    mfaCode.value = ''
    dialogStore.openDialog({
      title: t('alert-2fa-required'),
      description: t('alert-2fa-required-message'),
      preventAccidentalClose: true,
      buttons: [
        {
          text: t('button-confirm'),
          role: 'primary',
          handler: async () => {
            const { data: _verify, error: errorVerify } = await supabase.auth.mfa.verify({
              factorId: factor.id,
              challengeId: challenge.id,
              code: mfaCode.value.replaceAll(' ', ''),
            })
            if (errorVerify) {
              toast.error(t('invalid-mfa-code'))
              return false // Prevent dialog from closing
            }
          },
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
  const { error: updateError } = await supabase.auth.updateUser({ password: form.password })
  isLoading.value = false
  if (updateError) {
    setErrors('forgot-password', [updateError.message], {})
    return
  }
  form.password = ''
  form.password_confirm = ''
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' })
  if (signOutError) {
    setErrors('forgot-password', [signOutError.message], {})
    return
  }
  toast.success(t('forgot-success'))
  router.push('/dashboard')
}

async function submit(form: { email: string, password: string, password_confirm: string }) {
  isLoading.value = true
  if (step.value === 1) {
    await step1(form)
  }
  else if (step.value === 2) {
    await step2(form)
  }
}

watchEffect(() => {
  isLoadingMain.value = true
  if (route && (route.path === '/forgot_password' || route.path === '/forgot_password/')) {
    // console.log('router.currentRoute.value.query', router.currentRoute.value.query)
    if (router.currentRoute.value.query && router.currentRoute.value.query.step)
      step.value = Number.parseInt(router.currentRoute.value.query.step as string)
    else if (getRecoveryParams().accessToken || getRecoveryParams().refreshToken || getRecoveryParams().code)
      step.value = 2
    isLoadingMain.value = false
  }
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-lg"
    :card-kicker="t('forgot')"
    :card-title="t('reset-your-password')"
    :card-description="cardDescription"
  >
    <div v-if="isLoadingMain" class="flex justify-center py-10">
      <Spinner size="w-14 h-14" class="my-auto" />
    </div>

    <FormKit v-else id="forgot-password" type="form" :actions="false" :value="initialFormValue" @submit="submit">
      <div class="space-y-5 text-slate-500 dark:text-slate-300">
        <div v-if="step === 1">
          <FormKit
            type="email"
            name="email"
            :label="t('email')"
            :disabled="isLoading"
            :prefix-icon="iconEmail"
            data-test="email"
            inputmode="email"
            autocomplete="email"
            validation="required:trim"
          />
        </div>

        <div v-if="step === 2">
          <FormKit
            type="password"
            name="password"
            :prefix-icon="iconPassword"
            autocomplete="new-password"
            enterkeyhint="send"
            :disabled="isLoading"
            :label="t('password')"
            :help="t('6-characters-minimum')"
            validation="required|length:6"
            validation-visibility="dirty"
          />
        </div>

        <div v-if="step === 2">
          <FormKit
            type="password"
            :prefix-icon="iconPassword"
            name="password_confirm"
            autocomplete="new-password"
            :disabled="isLoading"
            :label="t('confirm-password')"
            :help="t('confirm-password')"
            validation="required|confirm"
            validation-visibility="dirty"
            :validation-label="t('password-confirmatio')"
          />
        </div>

        <div v-if="step === 1 && captchaKey" class="overflow-hidden">
          <VueTurnstile v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
        </div>

        <FormKitMessages />

        <div>
          <button type="submit" data-test="submit" :disabled="isLoading" :aria-busy="isLoading ? 'true' : 'false'" :class="authPrimaryButtonClass">
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
            {{ t('reset-password') }}
          </button>
        </div>

        <div :class="authPanelClass">
          <router-link to="/login" class="text-sm font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]">
            {{ t('back-to-login-page') }}
          </router-link>
        </div>
      </div>
    </FormKit>

    <template #footer>
      <section class="mt-6 flex flex-col items-center">
        <div class="mx-auto">
          <LangSelector />
        </div>
        <button class="mt-3" :class="authGhostButtonClass" @click="openSupport">
          {{ t('support') }}
        </button>
      </section>
    </template>
  </AuthPageShell>

  <!-- Teleport Content for 2FA Input -->
  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('alert-2fa-required')" defer to="#dialog-v2-content">
    <div class="space-y-4">
      <div>
        <label for="mfa-code" class="block mb-2 text-sm font-medium">{{ t('enter-2fa-code') }}</label>
        <input
          id="mfa-code"
          v-model="mfaCode"
          type="text"
          placeholder="123456"
          :aria-label="t('enter-2fa-code')"
          class="w-full input input-bordered"
          maxlength="6"
          inputmode="numeric"
        >
        <div class="text-sm text-gray-500">
          {{ t('enter-the-6-digit-code-from-your-authenticator-app') }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
