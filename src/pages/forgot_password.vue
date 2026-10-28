<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconEmail from '~icons/oui/email'
import IconPassword from '~icons/ph/key'
import { authGhostButtonClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import FormField from '~/components/forms/FormField.vue'
import VueTurnstile from '~/components/VueTurnstile.vue'
import { useConsole } from '~/services/console'
import { openSupport } from '~/services/support'
import { useDialogV2Store } from '~/stores/dialogv2'
import { rules, validateField } from '~/utils/formValidation'

const { t } = useI18n()
const router = useRouter()
const route = useRoute('/forgot_password')
const capgo = useConsole()
const dialogStore = useDialogV2Store()
const step = ref(1)
const turnstileToken = ref('')
const mfaCode = ref('')

const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)

const isLoading = ref(false)
const isLoadingMain = ref(true)
const email = ref('')
const password = ref('')
const passwordConfirm = ref('')
const submitted = ref(false)
const formErrors = ref<string[]>([])
const emailErrors = computed(() => validateField(email.value, [rules.required(t('email'), { trim: true })]))
const passwordErrors = computed(() => validateField(password.value, [rules.required(t('password')), rules.length(t('password'), 6)]))
const passwordConfirmErrors = computed(() => validateField(passwordConfirm.value, [
  rules.required(t('password-confirmatio')),
  rules.confirm(t('password-confirmatio'), () => password.value),
]))
const cardDescription = computed(() => step.value === 1 ? t('enter-your-email-add') : t('enter-your-new-passw'))

if (typeof history !== 'undefined') {
  const currentHistoryState = history.state as Record<string, unknown> | null
  if (typeof currentHistoryState?.resetEmail === 'string') {
    email.value = currentHistoryState.resetEmail
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
  formErrors.value = [message]
  if (error)
    console.error('forgot password error', error)
  isLoading.value = false
}

async function step1(form: { email: string }) {
  const redirectTo = `${import.meta.env.VITE_APP_URL}/forgot_password?step=2`
  // console.log('redirect', redirectTo)
  const { error } = await capgo.auth.resetPasswordForEmail(form.email, { redirectTo, captchaToken: turnstileToken.value })
  if (error) {
    if (error.message.includes('captcha')) {
      toast.error(t('captcha-fail'))
    }
    formErrors.value = [error.message]
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
    const { error: sessionError } = await capgo.auth.setSession({ refresh_token: refreshToken, access_token: accessToken })
    if (sessionError) {
      finishWithError(sessionError.message, sessionError)
      return
    }
  }
  else if (code) {
    const { error: exchangeError } = await capgo.auth.exchangeCodeForSession(code)
    if (exchangeError) {
      finishWithError(exchangeError.message, exchangeError)
      return
    }
  }
  else {
    finishWithError(t('expired'))
    return
  }
  const aal = await capgo.auth.mfa.getAuthenticatorAssuranceLevel()
  const { currentLevel, nextLevel } = aal.data!
  if (nextLevel !== currentLevel) {
    const { data: mfaFactors, error: mfaError } = await capgo.auth.mfa.listFactors()
    if (mfaError) {
      finishWithError(mfaError.message, mfaError)
      return
    }
    const factor = mfaFactors.all.find(factor => factor.status === 'verified')
    if (!factor) {
      finishWithError('Cannot find MFA factor')
      return
    }

    const { data: challenge, error: errorChallenge } = await capgo.auth.mfa.challenge({ factorId: factor.id })
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
            const { data: _verify, error: errorVerify } = await capgo.auth.mfa.verify({
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
  const { error: updateError } = await capgo.auth.updateUser({ password: form.password })
  isLoading.value = false
  if (updateError) {
    formErrors.value = [updateError.message]
    return
  }
  form.password = ''
  form.password_confirm = ''
  const { error: signOutError } = await capgo.auth.signOut({ scope: 'others' })
  if (signOutError) {
    formErrors.value = [signOutError.message]
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

function onSubmit() {
  submitted.value = true
  formErrors.value = []
  const hasErrors = step.value === 1
    ? emailErrors.value.length > 0
    : step.value === 2 && (passwordErrors.value.length > 0 || passwordConfirmErrors.value.length > 0)
  if (hasErrors)
    return
  return submit({ email: email.value, password: password.value, password_confirm: passwordConfirm.value })
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
      <CapgoLoader size="w-14 h-14" :label="t('loading')" class="my-auto" />
    </div>

    <form v-else id="forgot-password" novalidate @submit.prevent="onSubmit">
      <div class="space-y-5 text-slate-500 dark:text-slate-300">
        <div v-if="step === 1">
          <FormField
            v-model="email"
            type="email"
            name="email"
            :label="t('email')"
            :disabled="isLoading"
            :prefix-icon="IconEmail"
            data-test="email"
            inputmode="email"
            autocomplete="email"
            :errors="emailErrors"
            :submitted="submitted"
          />
        </div>

        <div v-if="step === 2">
          <FormField
            v-model="password"
            type="password"
            name="password"
            :prefix-icon="IconPassword"
            autocomplete="new-password"
            enterkeyhint="send"
            :disabled="isLoading"
            :label="t('password')"
            :help="t('6-characters-minimum')"
            :errors="passwordErrors"
            validation-visibility="dirty"
            :submitted="submitted"
          />
        </div>

        <div v-if="step === 2">
          <FormField
            v-model="passwordConfirm"
            type="password"
            :prefix-icon="IconPassword"
            name="password_confirm"
            autocomplete="new-password"
            :disabled="isLoading"
            :label="t('confirm-password')"
            :help="t('confirm-password')"
            :errors="passwordConfirmErrors"
            validation-visibility="dirty"
            :submitted="submitted"
          />
        </div>

        <div v-if="step === 1 && captchaKey" class="overflow-hidden">
          <VueTurnstile v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
        </div>

        <ul v-if="formErrors.length" role="alert" class="mb-1.5">
          <li v-for="error in formErrors" :key="error" class="text-xs text-red-600 dark:text-red-400">
            {{ error }}
          </li>
        </ul>

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
    </form>

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
          class="w-full d-input"
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
