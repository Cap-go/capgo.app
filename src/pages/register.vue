<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconEmail from '~icons/oui/email'
import IconPassword from '~icons/ph/key'
import { authGhostButtonClass, authInlineLinkClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import FormField from '~/components/forms/FormField.vue'
import VueTurnstile from '~/components/VueTurnstile.vue'
import { getCapgoApiErrorCode } from '~/services/capgoApi'
import { useConsole } from '~/services/console'
import { FunctionsHttpError } from '~/services/consoleClient'
import { registerAccount } from '~/services/registration'
import { openSupport } from '~/services/support'
import { rules, validateField } from '~/utils/formValidation'

const router = useRouter()
const capgo = useConsole()
const { t } = useI18n()
const turnstileToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const isLoading = ref(false)
const email = ref('')
const password = ref('')
const submitted = ref(false)
const formErrors = ref<string[]>([])
const emailErrors = computed(() => validateField(email.value, [rules.required(t('email'), { trim: true }), rules.email()]))
const passwordErrors = computed(() => validateField(password.value, [
  rules.required(t('password')),
  rules.length(t('password'), 6),
  rules.containsAlpha(t('password')),
  rules.containsUppercase(t('password')),
  rules.containsLowercase(t('password')),
  rules.containsNumeric(t('password')),
  rules.containsSymbol(t('password')),
]))

if (window.location.host === 'console.capgo.app') {
  // do not allow to register on webapp on production
  window.location.href = 'https://capgo.app/register/'
}

async function submit(form: { password: string, email: string }) {
  if (isLoading.value)
    return

  isLoading.value = true
  try {
    const registered = await registerAccount(form.email, form.password, turnstileToken.value)
    const { error } = await capgo.auth.setSession(registered.session)
    if (error)
      throw error
  }
  catch (error) {
    const code = await getCapgoApiErrorCode(error)
    let message = t('account-error')
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      const body = await error.context.clone().json().catch(() => null)
      if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
        message = body.message
    }
    formErrors.value = [code === 'account_deleted' ? t('used-to-create') : message]
    // Re-enable only after the error is shown, so a quick second click cannot start another signup.
    isLoading.value = false
    return
  }

  // The account exists and the user is signed in from here on: a navigation problem is not a
  // signup failure. Keep the spinner until onboarding has loaded, and fall back to a full page
  // load if the in-app navigation fails.
  try {
    const failure = await router.push('/dashboard')
    if (failure)
      isLoading.value = false
  }
  catch (navigationError) {
    console.error('Navigation after registration failed', navigationError)
    window.location.assign('/dashboard')
  }
}

function onSubmit() {
  submitted.value = true
  formErrors.value = []
  if (emailErrors.value.length || passwordErrors.value.length)
    return
  return submit({ email: email.value, password: password.value })
}
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-2xl"
    :card-kicker="t('register-heading')"
    :card-title="t('create-a-free-account')"
  >
    <form id="register-account" novalidate @submit.prevent="onSubmit">
      <div class="grid gap-4 text-slate-500 dark:text-slate-300 md:grid-cols-2">
        <div class="md:col-span-2">
          <ul v-if="formErrors.length" role="alert" data-test="form-error" class="mb-1.5">
            <li v-for="error in formErrors" :key="error" class="text-xs text-red-600 dark:text-red-400">
              {{ error }}
            </li>
          </ul>
        </div>

        <div class="md:col-span-2">
          <FormField
            v-model="email"
            type="email"
            name="email"
            :prefix-icon="IconEmail"
            autofocus
            autocomplete="email"
            inputmode="email"
            enterkeyhint="next"
            :errors="emailErrors"
            :submitted="submitted"
            :label="t('email')"
            data-test="email"
            outer-class="mb-0!"
          />
        </div>

        <div class="md:col-span-2">
          <FormField
            v-model="password"
            type="password"
            name="password"
            :prefix-icon="IconPassword"
            autocomplete="new-password"
            :label="t('password')"
            data-test="password"
            :errors="passwordErrors"
            validation-visibility="dirty"
            :submitted="submitted"
            outer-class="mb-0!"
          />
        </div>

        <div v-if="captchaKey" class="md:col-span-2 overflow-hidden">
          <VueTurnstile v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
        </div>

        <div class="md:col-span-2">
          <button
            :disabled="isLoading"
            type="submit"
            data-test="submit"
            :class="authPrimaryButtonClass"
          >
            <span v-if="!isLoading">{{ t('register-next') }}</span>
            <Spinner v-else size="w-5 h-5" color="fill-gray-100 text-white/70" />
          </button>
        </div>

        <div class="md:col-span-2 text-center">
          <p class="text-xs leading-6 text-slate-500 dark:text-slate-400">
            {{ t('register-terms-disclaimer') }}
          </p>
        </div>

        <div class="md:col-span-2" :class="authPanelClass">
          <p class="text-sm text-slate-600 dark:text-slate-300">
            {{ t('already-account') }}
          </p>
          <router-link to="/login" :class="authInlineLinkClass">
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
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
